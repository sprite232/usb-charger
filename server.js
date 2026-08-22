require("./charging-server");
/*
const express = require("express");
const generatePayload = require("promptpay-qr");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const PROMPTPAY_PHONE = process.env.PROMPTPAY_PHONE || "0969679951";
const RATE_MINUTES_PER_BAHT = 3;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const state = {
  chargerId: "charger01",
  status: "available",
  paymentMethod: null,
  amount: 0,
  chargeMinutes: 0,
  remainingMinutes: 0,
  relayOn: false,
  pendingQr: null,
  lastCommand: null,
  transactions: [],
};

function createTransaction(method, amount, extra = {}) {
  const chargeMinutes = amount * RATE_MINUTES_PER_BAHT;
  const tx = {
    id: `txn_${Date.now()}`,
    method,
    amount,
    chargeMinutes,
    remainingMinutes: chargeMinutes,
    status: "paid",
    createdAt: new Date().toISOString(),
    ...extra,
  };

  state.transactions.unshift(tx);
  state.status = "in-use";
  state.paymentMethod = method;
  state.amount = amount;
  state.chargeMinutes = chargeMinutes;
  state.remainingMinutes = chargeMinutes;
  state.relayOn = true;
  state.pendingQr = null;
  state.lastCommand = {
    type: "START_CHARGE",
    transactionId: tx.id,
    method,
    amount,
    chargeMinutes,
  };

  return tx;
}

function finishCharge(reason) {
  if (state.status !== "in-use") return null;

  const usedMinutes = state.chargeMinutes - state.remainingMinutes;
  const creditBaht =
    reason === "battery_full" && state.paymentMethod === "qr"
      ? Math.floor(state.remainingMinutes / RATE_MINUTES_PER_BAHT)
      : 0;

  const tx = state.transactions.find((item) => item.status === "paid");
  if (tx) {
    tx.status = "finished";
    tx.endedAt = new Date().toISOString();
    tx.endedReason = reason;
    tx.usedMinutes = usedMinutes;
    tx.creditBaht = creditBaht;
  }

  state.status = "available";
  state.paymentMethod = null;
  state.amount = 0;
  state.chargeMinutes = 0;
  state.remainingMinutes = 0;
  state.relayOn = false;
  state.lastCommand = { type: "STOP_CHARGE", reason, creditBaht };

  return tx;
}

app.get("/api/state", (req, res) => {
  res.json({
    ...state,
    rateMinutesPerBaht: RATE_MINUTES_PER_BAHT,
    promptpayPhone: PROMPTPAY_PHONE,
  });
});

app.post("/api/qr/create", async (req, res) => {
  const amount = Number(req.body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "จำนวนเงินไม่ถูกต้อง" });
  }

  if (state.status !== "available") {
    return res.status(409).json({ error: "ตู้กำลังถูกใช้งานอยู่" });
  }

  try {
    const payload = generatePayload(PROMPTPAY_PHONE, { amount });
    const qr = await QRCode.toDataURL(payload, {
      width: 360,
      margin: 2,
      color: { dark: "#111827", light: "#ffffff" },
    });

    state.pendingQr = {
      id: `qr_${Date.now()}`,
      amount,
      chargeMinutes: amount * RATE_MINUTES_PER_BAHT,
      payload,
      qr,
      createdAt: new Date().toISOString(),
    };

    res.json({ success: true, pendingQr: state.pendingQr });
  } catch (err) {
    res.status(500).json({ error: `สร้าง QR ไม่สำเร็จ: ${err.message}` });
  }
});

app.post("/api/qr/confirm", (req, res) => {
  if (!state.pendingQr) {
    return res.status(400).json({ error: "ยังไม่มี QR ที่รอยืนยัน" });
  }

  if (state.status !== "available") {
    return res.status(409).json({ error: "ตู้กำลังถูกใช้งานอยู่" });
  }

  // โหมดจำลอง: ผู้ใช้กดยืนยันเองหลังโอนเงิน
  // ระบบจริงควรเปลี่ยนเป็น webhook จาก payment gateway หรือ API ธนาคาร
  const tx = createTransaction("qr", state.pendingQr.amount, {
    qrId: state.pendingQr.id,
  });

  res.json({ success: true, transaction: tx, state });
});

app.post("/api/cash", (req, res) => {
  const method = req.body.method;
  const amount = Number(req.body.amount);
  const cashValues = {
    coin: [5, 10],
    bill: [20, 50, 100],
  };

  if (!cashValues[method] || !cashValues[method].includes(amount)) {
    return res.status(400).json({ error: "ชนิดเงินสดไม่รองรับ" });
  }

  if (state.status !== "available") {
    return res.status(409).json({ error: "ตู้กำลังถูกใช้งานอยู่" });
  }

  const tx = createTransaction(method, amount);
  res.json({ success: true, transaction: tx, state });
});

app.post("/api/tick", (req, res) => {
  if (state.status !== "in-use") {
    return res.json({ success: true, state });
  }

  state.remainingMinutes = Math.max(0, state.remainingMinutes - 1);
  if (state.remainingMinutes === 0) {
    finishCharge("time_up");
  }

  res.json({ success: true, state });
});

app.post("/api/battery-full", (req, res) => {
  const tx = finishCharge("battery_full");
  res.json({ success: true, transaction: tx, state });
});

app.post("/api/reset", (req, res) => {
  state.status = "available";
  state.paymentMethod = null;
  state.amount = 0;
  state.chargeMinutes = 0;
  state.remainingMinutes = 0;
  state.relayOn = false;
  state.pendingQr = null;
  state.lastCommand = { type: "RESET" };
  res.json({ success: true, state });
});

app.get("/api/esp32/command", (req, res) => {
  res.json({
    status: state.status,
    relayOn: state.relayOn,
    remainingMinutes: state.remainingMinutes,
    command: state.lastCommand,
  });
});

app.post("/api/esp32/report", (req, res) => {
  const { remainingMinutes, batteryFull } = req.body;

  if (Number.isFinite(Number(remainingMinutes))) {
    state.remainingMinutes = Math.max(0, Number(remainingMinutes));
  }

  if (batteryFull === true) {
    finishCharge("battery_full");
  }

  res.json({ success: true, state });
});

app.listen(PORT, () => {
  console.log(`Smart charger demo running at http://localhost:${PORT}`);
});
*/
