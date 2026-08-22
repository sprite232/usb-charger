const express = require("express");
const generatePayload = require("promptpay-qr");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const PROMPTPAY_PHONE = process.env.PROMPTPAY_PHONE || "0969679951";
const RATE_MINUTES_PER_BAHT = Number(process.env.RATE_MINUTES_PER_BAHT || 3);
const FIREBASE_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || "").replace(/\/$/, "");
const FIREBASE_AUTH = process.env.FIREBASE_AUTH || "";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const defaultExpenseRates = {
  electricity: 0.18,
  maintenance: 0.08,
  internet: 0.03,
  rent: 0.05,
};

const localState = {
  chargerId: "charger01",
  status: "available",
  relayOn: false,
  paymentMethod: null,
  amount: 0,
  chargeMinutes: 0,
  remainingMinutes: 0,
  pendingQr: null,
  lastCommand: null,
  transactions: [],
  deviceReports: [],
  expenses: [],
  updatedAt: new Date().toISOString(),
};

function nowIso() {
  return new Date().toISOString();
}

function firebasePath(resource) {
  const auth = FIREBASE_AUTH ? `?auth=${encodeURIComponent(FIREBASE_AUTH)}` : "";
  return `${FIREBASE_DATABASE_URL}/${resource}.json${auth}`;
}

async function firebaseRequest(method, resource, body) {
  if (!FIREBASE_DATABASE_URL) return null;

  const response = await fetch(firebasePath(resource), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firebase ${method} ${resource} failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function readState() {
  if (!FIREBASE_DATABASE_URL) return localState;

  const remote = await firebaseRequest("GET", "dashboard");
  if (!remote) return localState;

  Object.assign(localState, {
    ...localState,
    ...remote,
    transactions: Array.isArray(remote.transactions) ? remote.transactions : [],
    deviceReports: Array.isArray(remote.deviceReports) ? remote.deviceReports : [],
    expenses: Array.isArray(remote.expenses) ? remote.expenses : [],
  });

  return localState;
}

async function saveState() {
  localState.updatedAt = nowIso();
  if (FIREBASE_DATABASE_URL) {
    await firebaseRequest("PUT", "dashboard", localState);
  }
  return localState;
}

function normalizeAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function createTransaction(method, amount, extra = {}) {
  const chargeMinutes = Math.round(amount * RATE_MINUTES_PER_BAHT);
  const tx = {
    id: `txn_${Date.now()}`,
    method,
    amount,
    chargeMinutes,
    remainingMinutes: chargeMinutes,
    status: "paid",
    createdAt: nowIso(),
    ...extra,
  };

  localState.transactions.unshift(tx);
  localState.transactions = localState.transactions.slice(0, 100);
  localState.status = "in-use";
  localState.paymentMethod = method;
  localState.amount = amount;
  localState.chargeMinutes = chargeMinutes;
  localState.remainingMinutes = chargeMinutes;
  localState.relayOn = true;
  localState.pendingQr = null;
  localState.lastCommand = {
    type: "START_CHARGE",
    transactionId: tx.id,
    method,
    amount,
    chargeMinutes,
    createdAt: nowIso(),
  };

  return tx;
}

function addExpense(category, amount, note, source = "system") {
  const expense = {
    id: `exp_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    category,
    amount: Math.round(Number(amount) * 100) / 100,
    note: note || "",
    source,
    createdAt: nowIso(),
  };

  localState.expenses.unshift(expense);
  localState.expenses = localState.expenses.slice(0, 200);
  return expense;
}

function addAutomaticExpenses(tx) {
  Object.entries(defaultExpenseRates).forEach(([category, rate]) => {
    addExpense(category, tx.amount * rate, `คำนวณจากรายการ ${tx.id}`, "auto");
  });
}

function finishCharge(reason) {
  if (localState.status !== "in-use") return null;

  const usedMinutes = Math.max(0, localState.chargeMinutes - localState.remainingMinutes);
  const creditBaht =
    reason === "battery_full" && localState.paymentMethod === "qr"
      ? Math.floor(localState.remainingMinutes / RATE_MINUTES_PER_BAHT)
      : 0;

  const tx = localState.transactions.find((item) => item.status === "paid");
  if (tx) {
    tx.status = "finished";
    tx.endedAt = nowIso();
    tx.endedReason = reason;
    tx.usedMinutes = usedMinutes;
    tx.creditBaht = creditBaht;
  }

  localState.status = "available";
  localState.paymentMethod = null;
  localState.amount = 0;
  localState.chargeMinutes = 0;
  localState.remainingMinutes = 0;
  localState.relayOn = false;
  localState.lastCommand = { type: "STOP_CHARGE", reason, creditBaht, createdAt: nowIso() };

  return tx;
}

function dashboardSummary(state) {
  const transactions = state.transactions || [];
  const expenses = state.expenses || [];
  const revenue = transactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const totalExpenses = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const finished = transactions.filter((tx) => tx.status === "finished");
  const active = transactions.filter((tx) => tx.status === "paid");
  const usedMinutes = transactions.reduce((sum, tx) => sum + Number(tx.usedMinutes || 0), 0);

  const byMethod = transactions.reduce((acc, tx) => {
    const key = tx.method || "unknown";
    acc[key] = (acc[key] || 0) + Number(tx.amount || 0);
    return acc;
  }, {});

  const byExpenseCategory = expenses.reduce((acc, expense) => {
    const key = expense.category || "other";
    acc[key] = (acc[key] || 0) + Number(expense.amount || 0);
    return acc;
  }, {});

  return {
    revenue: Math.round(revenue * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    net: Math.round((revenue - totalExpenses) * 100) / 100,
    transactionCount: transactions.length,
    finishedCount: finished.length,
    activeCount: active.length,
    usedMinutes,
    byMethod,
    byExpenseCategory,
  };
}

app.get("/api/state", async (req, res) => {
  try {
    const state = await readState();
    res.json({
      ...state,
      rateMinutesPerBaht: RATE_MINUTES_PER_BAHT,
      promptpayPhone: PROMPTPAY_PHONE,
      firebaseEnabled: Boolean(FIREBASE_DATABASE_URL),
      summary: dashboardSummary(state),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const state = await readState();
    res.json({
      state,
      summary: dashboardSummary(state),
      firebaseEnabled: Boolean(FIREBASE_DATABASE_URL),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/qr/create", async (req, res) => {
  const amount = normalizeAmount(req.body.amount);

  if (!amount) return res.status(400).json({ error: "จำนวนเงินไม่ถูกต้อง" });
  if (localState.status !== "available") return res.status(409).json({ error: "ตู้กำลังถูกใช้งานอยู่" });

  try {
    const payload = generatePayload(PROMPTPAY_PHONE, { amount });
    const qr = await QRCode.toDataURL(payload, {
      width: 360,
      margin: 2,
      color: { dark: "#111827", light: "#ffffff" },
    });

    localState.pendingQr = {
      id: `qr_${Date.now()}`,
      amount,
      chargeMinutes: Math.round(amount * RATE_MINUTES_PER_BAHT),
      payload,
      qr,
      createdAt: nowIso(),
    };

    await saveState();
    res.json({ success: true, pendingQr: localState.pendingQr });
  } catch (err) {
    res.status(500).json({ error: `สร้าง QR ไม่สำเร็จ: ${err.message}` });
  }
});

app.post("/api/qr/confirm", async (req, res) => {
  if (!localState.pendingQr) return res.status(400).json({ error: "ยังไม่มี QR ที่รอยืนยัน" });
  if (localState.status !== "available") return res.status(409).json({ error: "ตู้กำลังถูกใช้งานอยู่" });

  const tx = createTransaction("qr", localState.pendingQr.amount, { qrId: localState.pendingQr.id });
  addAutomaticExpenses(tx);
  await saveState();
  res.json({ success: true, transaction: tx, state: localState });
});

app.post("/api/cash", async (req, res) => {
  const method = req.body.method;
  const amount = normalizeAmount(req.body.amount);
  const cashValues = {
    coin: [5, 10],
    bill: [20, 50, 100],
  };

  if (!cashValues[method] || !cashValues[method].includes(amount)) {
    return res.status(400).json({ error: "ชนิดเงินสดไม่รองรับ" });
  }

  if (localState.status !== "available") return res.status(409).json({ error: "ตู้กำลังถูกใช้งานอยู่" });

  const tx = createTransaction(method, amount);
  addAutomaticExpenses(tx);
  await saveState();
  res.json({ success: true, transaction: tx, state: localState });
});

app.post("/api/expense", async (req, res) => {
  const amount = normalizeAmount(req.body.amount);
  const category = String(req.body.category || "other").trim();

  if (!amount) return res.status(400).json({ error: "จำนวนรายจ่ายไม่ถูกต้อง" });
  if (!category) return res.status(400).json({ error: "กรุณาระบุหมวดรายจ่าย" });

  const expense = addExpense(category, amount, req.body.note, "manual");
  await saveState();
  res.json({ success: true, expense, state: localState });
});

app.post("/api/tick", async (req, res) => {
  if (localState.status === "in-use") {
    localState.remainingMinutes = Math.max(0, localState.remainingMinutes - 1);
    if (localState.remainingMinutes === 0) finishCharge("time_up");
    await saveState();
  }

  res.json({ success: true, state: localState });
});

app.post("/api/battery-full", async (req, res) => {
  const tx = finishCharge("battery_full");
  await saveState();
  res.json({ success: true, transaction: tx, state: localState });
});

app.post("/api/reset", async (req, res) => {
  localState.status = "available";
  localState.paymentMethod = null;
  localState.amount = 0;
  localState.chargeMinutes = 0;
  localState.remainingMinutes = 0;
  localState.relayOn = false;
  localState.pendingQr = null;
  localState.lastCommand = { type: "RESET", createdAt: nowIso() };
  await saveState();
  res.json({ success: true, state: localState });
});

app.get("/api/esp32/command", async (req, res) => {
  try {
    const state = await readState();
    res.json({
      status: state.status,
      relayOn: state.relayOn,
      remainingMinutes: state.remainingMinutes,
      command: state.lastCommand,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/esp32/report", async (req, res) => {
  const report = {
    id: `report_${Date.now()}`,
    chargerId: req.body.chargerId || localState.chargerId,
    relayOn: Boolean(req.body.relayOn),
    remainingMinutes: Number.isFinite(Number(req.body.remainingMinutes))
      ? Math.max(0, Number(req.body.remainingMinutes))
      : localState.remainingMinutes,
    currentMa: Number(req.body.currentMa || 0),
    voltageMv: Number(req.body.voltageMv || 0),
    energyWh: Number(req.body.energyWh || 0),
    batteryFull: req.body.batteryFull === true,
    note: req.body.note || "",
    createdAt: req.body.createdAt || nowIso(),
  };

  localState.deviceReports.unshift(report);
  localState.deviceReports = localState.deviceReports.slice(0, 100);
  localState.relayOn = report.relayOn;
  localState.remainingMinutes = report.remainingMinutes;

  if (report.batteryFull) finishCharge("battery_full");

  if (Array.isArray(req.body.expenses)) {
    req.body.expenses.forEach((item) => {
      const amount = normalizeAmount(item.amount);
      const category = String(item.category || "other").trim();
      if (amount && category) addExpense(category, amount, item.note, "esp32");
    });
  }

  await saveState();
  res.json({ success: true, report, state: localState });
});

app.listen(PORT, () => {
  console.log(`PromptPay receiver dashboard running at http://localhost:${PORT}`);
  console.log(FIREBASE_DATABASE_URL ? "Firebase sync enabled" : "Firebase sync disabled; using local memory");
});
