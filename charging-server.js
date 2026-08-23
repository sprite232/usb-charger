try { require("dotenv").config(); } catch(_) {} // local .env (ignored on Railway)
const express  = require("express");

const generatePayload = require("promptpay-qr");
const QRCode   = require("qrcode");
const multer   = require("multer");
const jwt      = require("jsonwebtoken");
const fs       = require("fs");
const path     = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(_) {}
}

// ─── Config (all from .env) ───────────────────────────────────────────────────
const CFG = {
  promptpayPhone:   process.env.PROMPTPAY_PHONE     || "0969679951",
  secondsPerBaht:   Number(process.env.SECONDS_PER_BAHT || 180), // 1 ฿ = 180 วิ = 3 นาที
  adminPin:         process.env.ADMIN_PIN            || "00000000", // ≥8 หลัก (แนะนำ)
  jwtSecret:        process.env.JWT_SECRET           || `secret-${Math.random()}`,
  easyslipKey:      process.env.EASYSLIP_API_KEY     || "",
  bankName:         process.env.BANK_NAME            || "กสิกรไทย (kbank)",
  bankAccount:      process.env.BANK_ACCOUNT         || "193-3-86131-3",
  bankAccountName:  process.env.BANK_ACCOUNT_NAME    || "ศุภกฤต สอนบุญมา",
  sessionExpireMs:  10 * 60 * 1000,   // 10 นาที
  slipMaxAgeMins:   30,
  cashScoreMin:     70,                // คะแนนรวมขั้นต่ำ (UV+Color+Magnetic)
};

// ─── Multer ───────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("รูปแบบไฟล์ไม่รองรับ (JPEG/PNG/WebP เท่านั้น)"), ok);
  },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (_, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ─── Port Definitions ─────────────────────────────────────────────────────────
const PORT_DEFS = [
  { id: "usb-a-1", label: "USB-A 1", type: "USB-A", relayGpio: 26 },
  { id: "usb-a-2", label: "USB-A 2", type: "USB-A", relayGpio: 27 },
  { id: "usb-c-1", label: "USB-C 1", type: "USB-C", relayGpio: 25 },
  { id: "usb-c-2", label: "USB-C 2", type: "USB-C", relayGpio: 33 },
];

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  deviceId: "charger01",
  ports: {},
  transactions: [],
  usedTransRefs: new Set(),   // ป้องกันสลิปซ้ำ
  lastEsp32: null,
  updatedAt: new Date().toISOString(),
};

PORT_DEFS.forEach((d) => {
  state.ports[d.id] = {
    ...d,
    status: "available",      // available | pending_payment | in-use
    relayOn: false,
    isPaused: false,          // หยุดชั่วคราว
    paymentSession: null,     // { id, portId, amount, method, chargeSeconds, createdAt, expiresAt, qr?, bank? }
    currentTx: null,
    remainingSeconds: 0,
  };
});

// ─── State Persistence (บันทึกลงไฟล์ ป้องกันไฟดับ/รีสตาร์ท) ─────────────────
function saveState() {
  try {
    const data = {
      transactions: state.transactions,
      usedTransRefs: Array.from(state.usedTransRefs),
      ports: Object.values(state.ports).map(p => ({
        id: p.id, status: p.status, relayOn: p.relayOn, isPaused: p.isPaused,
        remainingSeconds: p.remainingSeconds, currentTx: p.currentTx,
      })),
      updatedAt: state.updatedAt,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch(e) {
    console.error("[Persistence Error]", e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data.transactions && Array.isArray(data.transactions)) state.transactions = data.transactions;
    if (data.usedTransRefs && Array.isArray(data.usedTransRefs)) state.usedTransRefs = new Set(data.usedTransRefs);
    if (data.ports && Array.isArray(data.ports)) {
      data.ports.forEach(saved => {
        const p = state.ports[saved.id];
        if (p) {
          p.status = saved.status || "available";
          p.relayOn = !!saved.relayOn;
          p.isPaused = !!saved.isPaused;
          p.remainingSeconds = Number(saved.remainingSeconds) || 0;
          p.currentTx = saved.currentTx || null;
        }
      });
    }
    console.log(`[💾 Persistence] Loaded state with ${state.transactions.length} transactions & ${state.usedTransRefs.size} verified slips`);
  } catch(e) {
    console.error("[Persistence Load Error]", e.message);
  }
}
loadState();

// ─── Helpers ──────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const getPort = (id) => state.ports[id] || null;

function createTx(portId, amount, method, extra = {}) {
  const chargeSeconds = extra.testDuration || Math.round(amount * CFG.secondsPerBaht);
  const tx = {
    id: `txn_${Date.now()}`,
    portId, amount, method, chargeSeconds,
    status: "active",
    createdAt: now(),
    endedAt: null, endedReason: null, usedSeconds: null,
    verification: extra,
  };
  state.transactions.unshift(tx);
  state.transactions = state.transactions.slice(0, 500);
  saveState();
  return tx;
}

function activatePort(portId, amount, method, extra = {}) {
  const port = getPort(portId);
  if (!port) return null;
  const tx = createTx(portId, amount, method, extra);
  port.status = "in-use";
  port.relayOn = true;
  port.isPaused = false;
  port.paymentSession = null;
  port.currentTx = tx;
  port.remainingSeconds = tx.chargeSeconds;
  state.updatedAt = now();
  saveState();
  console.log(`[✅ Activated] port=${portId} ฿${amount} method=${method} tx=${tx.id}`);
  return tx;
}

function stopPort(portId, reason = "time_up") {
  const port = getPort(portId);
  if (!port || port.status !== "in-use") return false;
  if (port.currentTx) {
    port.currentTx.status = "finished";
    port.currentTx.endedAt = now();
    port.currentTx.endedReason = reason;
    port.currentTx.usedSeconds = Math.max(0, port.currentTx.chargeSeconds - port.remainingSeconds);
  }
  port.status = "available";
  port.relayOn = false;
  port.isPaused = false;
  port.currentTx = null;
  port.remainingSeconds = 0;
  state.updatedAt = now();
  saveState();
  return true;
}

function clearSession(portId) {
  const port = getPort(portId);
  if (!port || port.status !== "pending_payment") return;
  port.status = "available";
  port.paymentSession = null;
  port.isPaused = false;
  state.updatedAt = now();
  saveState();
}



function summary() {
  const txs = state.transactions;
  const revenue = txs.reduce((s, t) => s + t.amount, 0);
  return {
    revenue: Math.round(revenue * 100) / 100,
    transactionCount: txs.length,
    activeCount: txs.filter((t) => t.status === "active").length,
    finishedCount: txs.filter((t) => t.status === "finished").length,
    byMethod: txs.reduce((acc, t) => {
      acc[t.method] = (acc[t.method] || 0) + t.amount;
      return acc;
    }, {}),
  };
}

// ─── Background Tasks ──────────────────────────────────────────────────────────

// ✅ Countdown (ทุก 1 วินาที)
setInterval(() => {
  let changed = false;
  Object.values(state.ports).forEach((p) => {
    if (p.status === "in-use" && p.remainingSeconds > 0 && !p.isPaused) {
      p.remainingSeconds -= 1;
      changed = true;
      if (p.remainingSeconds <= 0) stopPort(p.id, "time_up");
    }
  });
  if (changed) state.updatedAt = now();
}, 1000);


// ✅ Session timeout (ทุก 30 วินาที)
setInterval(() => {
  Object.values(state.ports).forEach((p) => {
    if (p.status === "pending_payment" && p.paymentSession) {
      if (Date.now() > new Date(p.paymentSession.expiresAt).getTime()) {
        console.log(`[⌛ Session Expired] port=${p.id}`);
        clearSession(p.id);
      }
    }
  });
}, 30_000);

// ─── EasySlip Verification ────────────────────────────────────────────────────
async function verifySlip(imageBuffer, mimetype, expectedAmount) {
  // Dev mode: ถ้าไม่มี API key — ข้ามการตรวจ
  if (!CFG.easyslipKey) {
    console.warn("[⚠️  EasySlip] ไม่มี API key — DEV MODE (ข้ามการตรวจ)");
    return { valid: true, isDev: true, amount: expectedAmount, transRef: `DEV-${Date.now()}` };
  }

  const form = new FormData();
  const blob = new Blob([imageBuffer], { type: mimetype });
  form.append("image", blob, "slip.jpg");
  form.append("checkDuplicate", "true");
  form.append("matchAmount", String(expectedAmount));

  let result;
  try {
    const resp = await fetch("https://api.easyslip.com/v2/verify/bank", {
      method: "POST",
      headers: { Authorization: `Bearer ${CFG.easyslipKey}` },
      body: form,
    });
    result = await resp.json();
  } catch (err) {
    return { valid: false, reason: "API_ERROR", message: `ไม่สามารถเชื่อมต่อ EasySlip: ${err.message}` };
  }

  // API-level error
  if (!result.success) {
    const codeMap = {
      SLIP_NOT_FOUND:         "ไม่พบ QR Code ในรูป กรุณาถ่ายให้เห็น QR ชัดๆ",
      IMAGE_SIZE_TOO_LARGE:   "รูปขนาดใหญ่เกินไป (สูงสุด 4 MB)",
      INVALID_IMAGE_FORMAT:   "รูปแบบไฟล์ไม่ถูกต้อง",
      SLIP_PENDING:           "สลิปกรุงเทพฯ รอดำเนินการ กรุณารอ 5 นาทีแล้วลองใหม่",
    };
    const code = result.error?.code || "UNKNOWN";
    return { valid: false, reason: code, message: codeMap[code] || result.error?.message || "ตรวจสลิปไม่สำเร็จ" };
  }

  const data = result.data;
  const raw  = data.rawSlip;

  // 1. สลิปซ้ำ
  if (data.isDuplicate) {
    return { valid: false, reason: "DUPLICATE_SLIP", message: "❌ สลิปนี้ถูกใช้งานไปแล้ว" };
  }
  if (raw?.transRef && state.usedTransRefs.has(raw.transRef)) {
    return { valid: false, reason: "DUPLICATE_SLIP", message: "❌ สลิปนี้ถูกใช้ในระบบแล้ว" };
  }

  // 2. จำนวนเงิน
  const slipAmount = data.amountInSlip ?? raw?.amount?.amount ?? 0;
  if (slipAmount < expectedAmount) {
    return {
      valid: false, reason: "AMOUNT_TOO_LOW",
      message: `❌ จำนวนเงินไม่พอ (สลิป: ฿${slipAmount} — ต้องการ: ฿${expectedAmount})`,
    };
  }

  // 3. อายุสลิป (ไม่เกิน slipMaxAgeMins นาที)
  if (raw?.date) {
    const ageMins = (Date.now() - new Date(raw.date).getTime()) / 60000;
    if (ageMins > CFG.slipMaxAgeMins) {
      return { valid: false, reason: "SLIP_TOO_OLD", message: `❌ สลิปเก่าเกิน ${CFG.slipMaxAgeMins} นาที` };
    }
    if (ageMins < -5) {
      return { valid: false, reason: "SLIP_FUTURE", message: "❌ วันที่/เวลาในสลิปไม่ถูกต้อง" };
    }
  }

  // 4. ตรวจผู้รับ (PromptPay phone หรือ Bank Account)
  const receiverProxy = raw?.receiver?.account?.proxy?.account || "";
  const receiverAcc = raw?.receiver?.account?.bank?.account || raw?.receiver?.account?.account || "";
  
  if (receiverProxy && CFG.promptpayPhone) {
    const tail = (s) => s.replace(/\D/g, "").slice(-9);
    if (tail(receiverProxy) !== tail(CFG.promptpayPhone)) {
      return { valid: false, reason: "WRONG_RECEIVER", message: "❌ โอนไปยังเบอร์พร้อมเพย์ที่ไม่ตรงกับระบบ" };
    }
  } else if (receiverAcc && CFG.bankAccount && !CFG.bankAccount.includes("xxx")) {
    const norm = (s) => s.replace(/\D/g, "");
    if (norm(receiverAcc) && norm(CFG.bankAccount) && !norm(receiverAcc).includes(norm(CFG.bankAccount).slice(-6))) {
      return { valid: false, reason: "WRONG_RECEIVER", message: "❌ โอนไปยังเลขบัญชีที่ไม่ตรงกับระบบ" };
    }
  }

  // ผ่านทุกอย่าง — บันทึก transRef ป้องกันการใช้ซ้ำ
  if (raw?.transRef) {
    state.usedTransRefs.add(raw.transRef);
    saveState();
  }


  return {
    valid: true,
    transRef:  raw?.transRef || "",
    amount:    slipAmount,
    sender:    raw?.sender?.account?.name?.th || "ไม่ระบุ",
    slipDate:  raw?.date || "",
  };
}

// ─── Admin Middleware ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const bearer = (req.headers.authorization || "").replace("Bearer ", "");
  if (!bearer) return res.status(401).json({ error: "กรุณา Login ก่อน" });
  try {
    jwt.verify(bearer, CFG.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "Token หมดอายุ กรุณา Login ใหม่" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/state — สถานะตู้ (ผู้ใช้ทั่วไป)
app.get("/api/state", (_, res) => {
  res.json({
    deviceId: state.deviceId,
    secondsPerBaht: CFG.secondsPerBaht,
    easyslipEnabled: !!CFG.easyslipKey,
    updatedAt: state.updatedAt,
    ports: Object.values(state.ports).map((p) => ({
      id: p.id, label: p.label, type: p.type, relayGpio: p.relayGpio,
      status: p.status,
      relayOn: p.relayOn,
      isPaused: !!p.isPaused,
      remainingSeconds: p.remainingSeconds,
      totalSeconds: p.currentTx?.chargeSeconds || (p.remainingSeconds > 0 ? p.remainingSeconds : 0),
      currentTx: p.currentTx ? {
        amount: p.currentTx.amount,
        chargeSeconds: p.currentTx.chargeSeconds,
        method: p.currentTx.method,
      } : null,
      hasSession: !!p.paymentSession,
      sessionMethod: p.paymentSession?.method || null,
      sessionExpiresAt: p.paymentSession?.expiresAt || null,
    })),
  });
});



// ─── Payment ──────────────────────────────────────────────────────────────────

/**
 * POST /api/payment/create
 * Body: { portId, amount, method: 'qr'|'transfer'|'cash' }
 * สร้าง session การชำระ
 */
app.post("/api/payment/create", async (req, res) => {
  const { portId, method } = req.body;
  const amount = Number(req.body.amount);

  if (!["qr", "transfer", "cash"].includes(method)) {
    return res.status(400).json({ error: "วิธีชำระไม่ถูกต้อง (qr | transfer | cash)" });
  }
  if (!Number.isFinite(amount) || amount < 1) {
    return res.status(400).json({ error: "จำนวนเงินต้องไม่น้อยกว่า 1 บาท" });
  }
  if (method === "cash" && (amount < 5 || amount % 5 !== 0)) {
    return res.status(400).json({ error: "เงินสดรับเฉพาะยอดเริ่มต้น 5 บาท และเป็นทวีคูณของ 5 บาท (เช่น 5, 10, 15, 20, 25...)" });
  }



  const port = getPort(portId);
  if (!port)                       return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status !== "available") return res.status(409).json({ error: "พอร์ตนี้ไม่ว่าง", status: port.status });

  const rounded       = Math.round(amount * 100) / 100;
  const chargeSeconds = Math.round(rounded * CFG.secondsPerBaht);
  const expiresAt     = new Date(Date.now() + CFG.sessionExpireMs).toISOString();

  const session = {
    id: `sess_${Date.now()}`,
    portId, amount: rounded, method, chargeSeconds,
    createdAt: now(), expiresAt,
  };

  // Method-specific data
  if (method === "qr") {
    try {
      const payload  = generatePayload(CFG.promptpayPhone, { amount: rounded });
      const qrImage  = await QRCode.toDataURL(payload, { width: 320, margin: 2, color: { dark: "#111827", light: "#fff" } });
      session.qr = { payload, image: qrImage, phone: CFG.promptpayPhone };
    } catch (err) {
      return res.status(500).json({ error: `สร้าง QR ไม่สำเร็จ: ${err.message}` });
    }
  } else if (method === "transfer") {
    session.bank = { name: CFG.bankName, account: CFG.bankAccount, accountName: CFG.bankAccountName, phone: CFG.promptpayPhone };
  }
  // cash: ESP32 จะรายงานเอง

  port.status = "pending_payment";
  port.paymentSession = session;
  state.updatedAt = now();

  console.log(`[📋 Session] port=${portId} method=${method} ฿${rounded} id=${session.id}`);
  res.json({ success: true, session });
});

/**
 * POST /api/payment/verify-slip  (multipart/form-data)
 * Fields: portId (text), image (file)
 * ตรวจสลิปด้วย EasySlip API
 */
app.post("/api/payment/verify-slip", upload.single("image"), async (req, res) => {
  const port = getPort(req.body.portId);

  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status !== "pending_payment" || !port.paymentSession) {
    return res.status(400).json({ error: "ไม่มี session รอการชำระ" });
  }
  if (!["qr", "transfer"].includes(port.paymentSession.method)) {
    return res.status(400).json({ error: "วิธีชำระนี้ไม่ใช้สลิป" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "กรุณาอัปโหลดรูปสลิป" });
  }

  const session = port.paymentSession;
  console.log(`[🔍 Verify Slip] port=${port.id} ฿${session.amount} size=${req.file.size} bytes`);

  const result = await verifySlip(req.file.buffer, req.file.mimetype, session.amount);

  if (!result.valid) {
    console.log(`[❌ Slip Fail] port=${port.id} reason=${result.reason}`);
    return res.status(422).json({ success: false, reason: result.reason, message: result.message });
  }

  const tx = activatePort(port.id, session.amount, session.method, {
    transRef: result.transRef,
    sender:   result.sender,
    slipDate: result.slipDate,
    isDev:    result.isDev || false,
  });

  console.log(`[✅ Slip OK] port=${port.id} transRef=${result.transRef}`);
  res.json({ success: true, transaction: tx, sender: result.sender, isDev: result.isDev || false });
});

/**
 * POST /api/cash/insert  (จาก ESP32)
 * Body: { portId, amount, uvScore, colorScore, magneticScore }
 * ตรวจธนบัตรจริง — UV + สี + แม่เหล็ก
 */
app.post("/api/cash/insert", (req, res) => {
  const port = getPort(req.body.portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status !== "pending_payment" || port.paymentSession?.method !== "cash") {
    return res.status(409).json({ error: "พอร์ตนี้ไม่ได้รอการชำระด้วยเงินสด" });
  }

  const amount   = Number(req.body.amount || 0);
  const uv       = Number(req.body.uvScore       || 0); // 0–40
  const color    = Number(req.body.colorScore    || 0); // 0–30
  const magnetic = Number(req.body.magneticScore || 0); // 0–30
  const total    = uv + color + magnetic;
  const isFake   = total < CFG.cashScoreMin;

  console.log(`[💵 Cash] port=${port.id} ฿${amount} UV=${uv} Color=${color} Mag=${magnetic} Total=${total} fake=${isFake}`);

  if (isFake) {
    return res.status(422).json({
      success: false,
      reason: "COUNTERFEIT_DETECTED",
      message: `❌ ตรวจพบธนบัตรปลอม (คะแนน ${total}/100 — ต้องการ ≥ ${CFG.cashScoreMin})`,
      scores: { uv, color, magnetic, total },
    });
  }
  if (!Number.isFinite(amount) || amount < port.paymentSession.amount) {
    return res.status(422).json({
      success: false,
      reason: "AMOUNT_TOO_LOW",
      message: `❌ ใส่เงิน ฿${amount} ไม่พอ (ต้องการ ฿${port.paymentSession.amount})`,
    });
  }

  const tx = activatePort(port.id, port.paymentSession.amount, "cash", {
    cashInserted: amount, scores: { uv, color, magnetic, total },
  });
  res.json({ success: true, transaction: tx, scores: { uv, color, magnetic, total } });
});

/**
 * POST /api/payment/cancel
 * Body: { portId }
 */
app.post("/api/payment/cancel", (req, res) => {
  const port = getPort(req.body.portId);
  if (port) clearSession(port.id);
  res.json({ success: true });
});

// ─── Admin ────────────────────────────────────────────────────────────────────

// Rate limiting for admin login (ป้องกัน Brute-Force PIN)
const loginAttempts = new Map(); // ip -> { count, lockUntil }

// POST /api/admin/login — { pin } → { token }
app.post("/api/admin/login", (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || "local";
  const nowMs = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };

  if (rec.lockUntil > nowMs) {
    const remainSec = Math.ceil((rec.lockUntil - nowMs) / 1000);
    return res.status(429).json({ error: `ใส่รหัสผิดเกินจำนวน กรุณารอ ${remainSec} วินาที` });
  }

  if (String(req.body.pin) !== String(CFG.adminPin)) {
    rec.count += 1;
    if (rec.count >= 5) {
      rec.lockUntil = nowMs + 5 * 60 * 1000; // ล็อก 5 นาที
      rec.count = 0;
      loginAttempts.set(ip, rec);
      return res.status(429).json({ error: "ใส่รหัสผิดเกิน 5 ครั้ง บัญชีถูกระงับชั่วคราว 5 นาที" });
    }
    loginAttempts.set(ip, rec);
    return res.status(401).json({ error: `PIN ไม่ถูกต้อง (เหลือโอกาส ${5 - rec.count} ครั้ง)` });
  }

  // เข้าสู่ระบบสำเร็จ -> รีเซ็ตการนับ
  loginAttempts.delete(ip);
  const token = jwt.sign({ role: "admin" }, CFG.jwtSecret, { expiresIn: "4h" });
  console.log("[🔐 Admin] Login success");
  res.json({ success: true, token });
});


// GET /api/admin/dashboard — full data (admin only)
app.get("/api/admin/dashboard", requireAdmin, (_, res) => {
  res.json({
    summary: summary(),
    ports: Object.values(state.ports),
    transactions: state.transactions.slice(0, 100),
    config: {
      promptpayPhone: CFG.promptpayPhone,
      bankName: CFG.bankName,
      bankAccount: CFG.bankAccount,
      bankAccountName: CFG.bankAccountName,
      secondsPerBaht: CFG.secondsPerBaht,
      easyslipEnabled: !!CFG.easyslipKey,
    },
    lastEsp32: state.lastEsp32,
    updatedAt: state.updatedAt,
  });
});

// POST /api/admin/port/:id/stop (admin only)
app.post("/api/admin/port/:id/stop", requireAdmin, (req, res) => {
  const ok = stopPort(req.params.id, "admin_stop");
  console.log(`[🔐 Admin] Stop port=${req.params.id} ok=${ok}`);
  res.json({ success: ok });
});

// POST /api/admin/port/:id/clear  (admin only)
app.post("/api/admin/port/:id/clear", requireAdmin, (req, res) => {
  clearSession(req.params.id);
  res.json({ success: true });
});

// POST /api/admin/port/:id/pause (admin only) — พักชาร์จชั่วคราว (หยุดนับเวลา & ตัดไฟ relay)
app.post("/api/admin/port/:id/pause", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port || port.status !== "in-use") return res.status(400).json({ error: "พอร์ตไม่ได้อยู่ในสถานะชาร์จ" });
  port.isPaused = true;
  port.relayOn = false; // ตัดไฟ relay ระหว่าง pause
  state.updatedAt = now();
  console.log(`[⏸️ Admin] Pause port=${port.id} remaining=${port.remainingSeconds}s`);
  res.json({ success: true, isPaused: true, remainingSeconds: port.remainingSeconds });
});

// POST /api/admin/port/:id/resume (admin only) — ชาร์จต่อ (เดินเวลาต่อ & เปิดไฟ relay)
app.post("/api/admin/port/:id/resume", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port || port.status !== "in-use") return res.status(400).json({ error: "พอร์ตไม่ได้อยู่ในสถานะชาร์จ" });
  port.isPaused = false;
  port.relayOn = true; // จ่ายไฟ relay ต่อ
  state.updatedAt = now();
  console.log(`[▶️ Admin] Resume port=${port.id} remaining=${port.remainingSeconds}s`);
  res.json({ success: true, isPaused: false, remainingSeconds: port.remainingSeconds });
});

// POST /api/admin/port/:id/test-start (admin only) — ทดสอบเริ่มชาร์จจำลอง (ไม่ต้องจ่ายเงินจริง)
app.post("/api/admin/port/:id/test-start", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status === "in-use") return res.status(409).json({ error: "พอร์ตนี้กำลังใช้งานอยู่ กรุณาหยุดก่อน" });

  const durationSeconds = Number(req.body.durationSeconds) || 30; // ค่าเริ่มต้น 30 วินาที
  const amount = Number(req.body.amount) || Math.max(1, Math.round(durationSeconds / CFG.secondsPerBaht));

  const tx = activatePort(port.id, amount, "test", {
    isTest: true,
    testDuration: durationSeconds,
    tester: "Admin Simulator",
    testStartedAt: now(),
  });

  console.log(`[🧪 Admin Test] Started test on port=${port.id} for ${durationSeconds}s`);
  res.json({ success: true, transaction: tx, durationSeconds, port: state.ports[port.id] });
});

// POST /api/admin/port/:id/set-time (admin only) — ปรับ/เร่งเวลาจำลอง (เช่น ปรับเหลือ 5 วิ เพื่อดูระบบตัดเวลา)
app.post("/api/admin/port/:id/set-time", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port || port.status !== "in-use") return res.status(400).json({ error: "พอร์ตไม่ได้อยู่ในสถานะชาร์จ" });
  const seconds = Math.max(1, Number(req.body.seconds) || 5);
  port.remainingSeconds = seconds;
  state.updatedAt = now();
  console.log(`[⏩ Admin Fast-Forward] Set port=${port.id} remaining=${seconds}s`);
  res.json({ success: true, remainingSeconds: port.remainingSeconds });
});

// POST /api/admin/port/:id/toggle-relay (admin only) — ทดสอบฮาร์ดแวร์ Relay สลับ เปิด/ปิด โดยตรง
app.post("/api/admin/port/:id/toggle-relay", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  const turnOn = typeof req.body.on === "boolean" ? req.body.on : !port.relayOn;
  port.relayOn = turnOn;
  state.updatedAt = now();
  console.log(`[🔌 Admin Relay Test] Port=${port.id} GPIO=${port.relayGpio} RelayOn=${turnOn}`);
  res.json({ success: true, portId: port.id, relayGpio: port.relayGpio, relayOn: port.relayOn });
});

// POST /api/admin/reset (admin only)
app.post("/api/admin/reset", requireAdmin, (_, res) => {
  Object.values(state.ports).forEach((p) => {
    p.status = "available"; p.relayOn = false; p.isPaused = false;
    p.paymentSession = null; p.currentTx = null; p.remainingSeconds = 0;
  });
  state.updatedAt = now();
  console.log("[🔐 Admin] Reset all ports");
  res.json({ success: true });
});

// ─── ESP32 ────────────────────────────────────────────────────────────────────

app.get("/api/esp32/command", (_, res) => {
  const relays = {};
  Object.values(state.ports).forEach((p) => {
    relays[p.id] = { gpio: p.relayGpio, on: p.relayOn, isPaused: !!p.isPaused, remainingSeconds: p.remainingSeconds };
  });
  res.json({ relays, updatedAt: state.updatedAt });
});


app.post("/api/esp32/report", (req, res) => {
  state.lastEsp32 = { ...req.body, receivedAt: now() };
  state.updatedAt = now();
  res.json({ success: true });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes("รูปแบบ")) {
    return res.status(400).json({ error: err.message });
  }
  console.error("[Server Error]", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🔌 Smart USB Charger v2`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Admin:      http://localhost:${PORT}/admin`);
  console.log(`   PromptPay:  ${CFG.promptpayPhone}`);
  console.log(`   Rate:       1 ฿ = ${CFG.secondsPerBaht / 60} นาที`);
  console.log(`   EasySlip:   ${CFG.easyslipKey ? "✅ เปิดใช้งาน" : "⚠️  DEV MODE (ไม่มี API key)"}`);
  if (CFG.adminPin === "00000000") console.warn("   ⚠️  Admin PIN ยังเป็นค่าเริ่มต้น กรุณาตั้ง ADMIN_PIN (≥8 หลัก) ใน .env !");
  console.log("");
});
