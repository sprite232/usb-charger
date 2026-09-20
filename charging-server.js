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

const bcrypt   = require("bcryptjs");

// ─── Firebase Admin (Firestore real-time sync) ────────────────────────────────
let db = null;
let fbAdmin = null;
try {
  fbAdmin = require("firebase-admin");
  const credential = process.env.FIREBASE_SERVICE_ACCOUNT
    ? fbAdmin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    : fbAdmin.credential.applicationDefault();

  if (!fbAdmin.apps.length) {
    fbAdmin.initializeApp({
      credential,
      projectId: process.env.FIREBASE_PROJECT_ID || "usb-charger-project",
    });
  }
  db = fbAdmin.firestore();
  console.log("[🔥 Firestore] เชื่อมต่อ Firebase สำเร็จ — state จะ sync real-time ทุก device");
} catch(e) {
  console.warn("[🔥 Firestore] ไม่ได้ตั้งค่า FIREBASE_SERVICE_ACCOUNT — ใช้ local state.json แทน");
}

// ── push state ไปยัง Firestore (non-blocking) ──
async function pushToFirestore(payload) {
  if (!db) return;
  try {
    await db.collection("charger").doc("charger01").set(payload, { merge: true });
  } catch(e) {
    console.warn("[Firestore push error]", e.message);
  }
}

// ─── Config (all from .env) ───────────────────────────────────────────────────
const CFG = {
  promptpayPhone:   process.env.PROMPTPAY_PHONE     || "0969679951",
  truemoneyPhone:   process.env.TRUEMONEY_PHONE     || process.env.PROMPTPAY_PHONE || "0969679951",
  secondsPerBaht:   Number(process.env.SECONDS_PER_BAHT || 180), // 1 ฿ = 180 วิ = 3 นาที
  // Hash รหัสผ่านแอดมินด้วย bcrypt (ไม่มี plain text ในโค้ด)
  adminPinHash:     process.env.ADMIN_PIN_HASH || (process.env.ADMIN_PIN ? bcrypt.hashSync(String(process.env.ADMIN_PIN), 10) : "$2b$10$rHV5FympGk4lK.g4Mnom5e1p6lcW5q5eW21bYZ/nQ/vhmEmLC0OFm"),
  jwtSecret:        process.env.JWT_SECRET           || `secret-${Math.random()}`,
  easyslipKey:      process.env.EASYSLIP_API_KEY     || "",
  esp32Secret:      process.env.ESP32_SECRET         || "esp32_device_secret_2026_x89q",
  bankName:         process.env.BANK_NAME            || "กสิกรไทย (kbank)",
  bankAccount:      process.env.BANK_ACCOUNT         || "193-3-86131-3",
  bankAccountName:  process.env.BANK_ACCOUNT_NAME    || "ศุภกฤต สอนบุญมา",
  supportPhone:     process.env.SUPPORT_PHONE        || "0969679951",
  supportLine:      process.env.SUPPORT_LINE         || "@smartcharger",
  supportLocation:  process.env.SUPPORT_LOCATION     || "ห้องคอมพิวเตอร์ อาคาร 1",
  sessionExpireMs:  Math.min(600_000, Math.max(30_000, Number(process.env.PAYMENT_SESSION_EXPIRE_SECONDS || 120) * 1000)),
  slipMaxAgeMins:   30,
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
    const ports = Object.values(state.ports).map(p => ({
      id: p.id, label: p.label, type: p.type, relayGpio: p.relayGpio,
      status: p.status, relayOn: p.relayOn, isPaused: p.isPaused,
      remainingSeconds: p.remainingSeconds, currentTx: p.currentTx,
      totalSeconds: p.currentTx?.chargeSeconds || 0,
    }));
    const data = {
      transactions: state.transactions,
      usedTransRefs: Array.from(state.usedTransRefs),
      visits: state.visits || [],
      ports,
      config: {
        promptpayPhone: CFG.promptpayPhone,
        bankName: CFG.bankName,
        bankAccount: CFG.bankAccount,
        bankAccountName: CFG.bankAccountName,
        secondsPerBaht: CFG.secondsPerBaht,
        easyslipKey: CFG.easyslipKey,
        supportPhone: CFG.supportPhone,
        supportLine: CFG.supportLine,
        supportLocation: CFG.supportLocation,
        truemoneyPhone: CFG.truemoneyPhone,
      },
      updatedAt: state.updatedAt,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf8");

    // ── Firestore real-time sync ──
    pushToFirestore({
      ports,
      secondsPerBaht: CFG.secondsPerBaht,
      supportPhone: CFG.supportPhone,
      supportLine: CFG.supportLine,
      supportLocation: CFG.supportLocation,
      truemoneyPhone: CFG.truemoneyPhone,
      updatedAt: state.updatedAt,
      deviceId: state.deviceId,
    });
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
    if (data.visits && Array.isArray(data.visits)) state.visits = data.visits;
    if (data.config) {
      if (data.config.promptpayPhone) CFG.promptpayPhone = data.config.promptpayPhone;
      if (data.config.bankName) CFG.bankName = data.config.bankName;
      if (data.config.bankAccount) CFG.bankAccount = data.config.bankAccount;
      if (data.config.bankAccountName) CFG.bankAccountName = data.config.bankAccountName;
      if (data.config.secondsPerBaht) CFG.secondsPerBaht = Number(data.config.secondsPerBaht);
      if (data.config.easyslipKey) CFG.easyslipKey = data.config.easyslipKey;
      if (data.config.supportPhone) CFG.supportPhone = data.config.supportPhone;
      if (data.config.supportLine) CFG.supportLine = data.config.supportLine;
      if (data.config.supportLocation) CFG.supportLocation = data.config.supportLocation;
    }
    if (data.ports && Array.isArray(data.ports)) {
      const lastTime = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
      const passedSeconds = lastTime ? Math.max(0, Math.floor((Date.now() - lastTime) / 1000)) : 0;
      data.ports.forEach(saved => {
        const p = state.ports[saved.id];
        if (p) {
          p.status = saved.status || "available";
          p.relayOn = !!saved.relayOn;
          p.isPaused = !!saved.isPaused;
          p.remainingSeconds = Number(saved.remainingSeconds) || 0;
          p.currentTx = saved.currentTx || null;
          if (p.status === "in-use" && p.remainingSeconds > 0 && !p.isPaused) {
            p.remainingSeconds = Math.max(0, p.remainingSeconds - passedSeconds);
            if (p.remainingSeconds <= 0) {
              p.status = "available";
              p.relayOn = false;
              p.remainingSeconds = 0;
              p.currentTx = null;
            }
          } else if (p.status !== "in-use") {
            p.status = "available";
            p.relayOn = false;
            p.remainingSeconds = 0;
            p.currentTx = null;
          }
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

function expirePaymentSession(port) {
  if (!port?.paymentSession?.expiresAt) return false;
  if (Date.now() < new Date(port.paymentSession.expiresAt).getTime()) return false;
  console.log(`[⌛ Session Expired] port=${port.id}`);
  clearSession(port.id);
  return true;
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


// ✅ Session timeout — ปลดล็อกพอร์ตที่รอชำระให้คนถัดไปโดยเร็ว
setInterval(() => {
  Object.values(state.ports).forEach((p) => {
    if (p.status === "pending_payment" && p.paymentSession) {
      expirePaymentSession(p);
    }
  });
}, 5_000);

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

  // 4. ตรวจผู้รับ (PromptPay phone, Bank Account, หรือชื่อบัญชี)
  const receiverProxy = raw?.receiver?.account?.proxy?.account || raw?.receiver?.proxy?.account || "";
  const receiverAcc = raw?.receiver?.account?.bank?.account || raw?.receiver?.account?.account || "";
  const receiverName = raw?.receiver?.account?.name?.th || raw?.receiver?.name || raw?.receiver?.displayName || "";

  let receiverMatch = false;

  // ตรวจชื่อผู้รับ (เช่น ศุภกฤต)
  if (receiverName && (receiverName.includes("ศุภกฤต") || receiverName.includes("supakit"))) {
    receiverMatch = true;
  }

  // ตรวจเบอร์ PromptPay (รองรับทั้งแบบเต็ม และแบบ masked เช่น xxx-xxx-9951)
  if (!receiverMatch && receiverProxy && CFG.promptpayPhone) {
    const proxyDigits = receiverProxy.replace(/\D/g, "");
    const cfgDigits = CFG.promptpayPhone.replace(/\D/g, "");
    if (proxyDigits.length >= 4 && cfgDigits.endsWith(proxyDigits.slice(-4))) {
      receiverMatch = true;
    }
  }

  // ตรวจเลขที่บัญชีธนาคาร (รองรับ masked เช่น 193-x-x6131-x)
  if (!receiverMatch && receiverAcc && CFG.bankAccount) {
    const accDigits = receiverAcc.replace(/\D/g, "");
    const cfgAccDigits = CFG.bankAccount.replace(/\D/g, "");
    if (accDigits.length >= 4 && cfgAccDigits.endsWith(accDigits.slice(-4))) {
      receiverMatch = true;
    }
  }

  // ถ้ามีข้อมูลผู้รับระบุในสลิป แต่ไม่ตรงกับระบบเลย
  if ((receiverProxy || receiverAcc || receiverName) && !receiverMatch) {
    return { valid: false, reason: "WRONG_RECEIVER", message: "❌ สลิปไม่ได้โอนเข้าบัญชีหรือพร้อมเพย์ของตู้ชาร์จนี้" };
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

// ─── Rate Limiter Engine ──────────────────────────────────────────────────────
function createRateLimiter({ windowMs, maxRequests, message }) {
  const hits = new Map(); // ip -> [timestamps]
  return (req, res, next) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip || req.socket?.remoteAddress || "local").split(",")[0].trim();
    const nowMs = Date.now();
    const timestamps = (hits.get(ip) || []).filter(t => nowMs - t < windowMs);
    if (timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((timestamps[0] + windowMs - nowMs) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: message || "คำขอมากเกินไป กรุณารอสักครู่แล้วลองใหม่", retryAfterSeconds: retryAfter });
    }
    timestamps.push(nowMs);
    hits.set(ip, timestamps);
    // Cleanup old map entries
    if (hits.size > 2000) {
      for (const [k, arr] of hits.entries()) {
        if (arr.every(t => nowMs - t >= windowMs)) hits.delete(k);
      }
    }
    next();
  };
}

const limiterIssues        = createRateLimiter({ windowMs: 5 * 60 * 1000,  maxRequests: 5,  message: "แจ้งปัญหาบ่อยเกินไป กรุณารอ 5 นาทีแล้วลองใหม่" });
const limiterVerifySlip    = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 5,  message: "ตรวจสอบสลิปเกินจำนวนที่กำหนด (สูงสุด 5 ครั้ง/15 นาที)" });
const limiterCoin          = createRateLimiter({ windowMs: 60 * 1000,      maxRequests: 30, message: "คำขอหยอดเหรียญบ่อยเกินไป (สูงสุด 30 ครั้ง/นาที)" });
const limiterPaymentCreate = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 10, message: "สร้างคำขอชำระเงินเกินจำนวนที่กำหนด (สูงสุด 10 ครั้ง/15 นาที)" });

// ─── Hardware Device Authentication (ESP32) ───────────────────────────────────
function requireEsp32Auth(req, res, next) {
  const secretHeader = req.headers["x-esp32-secret"] || req.headers["x-device-token"] || req.headers["x-device-secret"];
  const querySecret  = req.query?.secret;
  const bodySecret   = req.body?.secret;
  const provided     = secretHeader || querySecret || bodySecret;

  if (!CFG.esp32Secret || !provided || String(provided).trim() !== CFG.esp32Secret) {
    return res.status(403).json({ error: "ไม่อนุญาต: ขาดการยืนยันตัวตนจากอุปกรณ์ฮาร์ดแวร์ (Invalid or Missing Device Secret)" });
  }
  next();
}

// ─── Admin Middleware (Strict JWT & Firebase Auth Verification) ───────────────
async function requireAdmin(req, res, next) {
  const bearer = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!bearer) return res.status(401).json({ error: "กรุณา Login ก่อน (Missing Authorization Token)" });

  // 1. ตรวจสอบ JWT ที่ออกโดยระบบ Server ตัวเอง
  try {
    const decoded = jwt.verify(bearer, CFG.jwtSecret);
    if (decoded && decoded.role === "admin") {
      req.adminUser = decoded;
      return next();
    }
  } catch (_) {}

  // 2. ตรวจสอบ Firebase ID Token (กรณีล็อกอินผ่าน Google Sign-In ใน admin.html)
  if (fbAdmin && fbAdmin.apps.length) {
    try {
      const decodedFb = await fbAdmin.auth().verifyIdToken(bearer);
      if (decodedFb && decodedFb.email && db) {
        const whiteDoc = await db.collection("admin_whitelist").doc(decodedFb.email.toLowerCase()).get();
        if (whiteDoc.exists) {
          req.adminUser = { user: decodedFb.email, role: "admin", provider: "firebase" };
          return next();
        }
      }
    } catch (_) {}
  }

  return res.status(401).json({ error: "Token ไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่" });
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
    supportPhone: CFG.supportPhone,
    supportLine: CFG.supportLine,
    supportLocation: CFG.supportLocation,
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
 * Body: { portId, amount, method: 'qr'|'transfer'|'coin' }
 * สร้าง session การชำระ
 */
app.post("/api/payment/create", limiterPaymentCreate, async (req, res) => {
  const { portId, method } = req.body;
  const amount = Number(req.body.amount);

  if (!["qr", "transfer", "coin"].includes(method)) {
    return res.status(400).json({ error: "วิธีชำระไม่ถูกต้อง (qr | transfer | coin)" });
  }
  if (!Number.isFinite(amount) || amount < 1) {
    return res.status(400).json({ error: "จำนวนเงินต้องไม่น้อยกว่า 1 บาท" });
  }
  if (method === "coin" && (amount < 5 || amount % 5 !== 0)) {
    return res.status(400).json({ error: "รับชำระด้วยเหรียญเฉพาะยอด 5 บาทขึ้นไป และเป็นทวีคูณของ 5 บาท" });
  }

  const port = getPort(portId);
  if (!port)                       return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status !== "available") return res.status(409).json({ error: "พอร์ตนี้ไม่ว่าง", status: port.status });

  const rounded       = Math.round(amount * 100) / 100;
  const chargeSeconds = Math.round(rounded * CFG.secondsPerBaht);
  const expiresAt     = new Date(Date.now() + CFG.sessionExpireMs).toISOString();

  const session = {
    id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
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

  port.status = "pending_payment";
  port.paymentSession = session;
  state.updatedAt = now();

  console.log(`[📋 Session] port=${portId} method=${method} ฿${rounded} id=${session.id}`);
  res.json({ success: true, session });
});

/**
 * POST /api/payment/verify-slip  (multipart/form-data)
 * Fields: portId (text), image (file)
 * ตรวจสลิปด้วย EasySlip API (Backend Proxy เท่านั้น)
 */
app.post("/api/payment/verify-slip", limiterVerifySlip, upload.single("image"), async (req, res) => {
  const port = getPort(req.body.portId);

  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (expirePaymentSession(port)) return res.status(410).json({ error: "หมดเวลาชำระเงิน กรุณาเริ่มรายการใหม่" });
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
 * POST /api/payment/truemoney-voucher
 * Body: { portId, amount, voucherUrl }
 */
app.post("/api/payment/truemoney-voucher", limiterPaymentCreate, async (req, res) => {
  const { portId, amount, voucherUrl } = req.body;
  const port = getPort(portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status === "in-use") return res.status(409).json({ error: "พอร์ตนี้กำลังใช้งานอยู่" });

  if (!voucherUrl || typeof voucherUrl !== "string") {
    return res.status(400).json({ error: "กรุณาระบุลิงก์ซองของขวัญ TrueMoney" });
  }

  const expectedAmount = Number(amount);
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
    return res.status(400).json({ error: "ยอดเงินไม่ถูกต้อง" });
  }

  // Extract hash (35 characters)
  const hashMatch = (voucherUrl.split("v=")[1] || voucherUrl).match(/[0-9A-Za-z]{35}/);
  if (!hashMatch) {
    return res.status(400).json({ error: "ลิงก์ซองของขวัญไม่ถูกต้อง (ต้องเป็นลิงก์ gift.truemoney.com)" });
  }
  const hash = hashMatch[0];
  const targetMobile = CFG.truemoneyPhone || CFG.promptpayPhone || "0969679951";

  try {
    const { execFile } = require("child_process");
    const curlBin = process.platform === "win32" ? "curl.exe" : "curl";
    const payload = JSON.stringify({ mobile: targetMobile, voucher_hash: hash });

    execFile(curlBin, [
      "-s",
      "-X", "POST",
      `https://gift.truemoney.com/campaign/vouchers/${hash}/redeem`,
      "-H", "Content-Type: application/json",
      "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "-d", payload
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        return res.status(502).json({ error: "เชื่อมต่อเซิร์ฟเวอร์ TrueMoney ไม่สำเร็จ: " + err.message });
      }

      let data;
      try {
        data = JSON.parse(stdout);
      } catch(e) {
        return res.status(502).json({ error: "TrueMoney ตอบกลับข้อมูลไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง" });
      }

      if (data?.status?.code === "SUCCESS" || data?.status?.message === "success") {
        const redeemedAmt = parseFloat(data.data?.my_ticket?.amount_baht || data.data?.voucher?.redeemed_amount_baht || 0);
        if (redeemedAmt < expectedAmount) {
          return res.status(422).json({
            error: `ยอดเงินในซองของขวัญไม่เพียงพอ (ต้องการ ฿${expectedAmount} แต่ในซองมี ฿${redeemedAmt})`
          });
        }

        const senderName = data.data?.owner_profile?.full_name || "TrueMoney Wallet";
        const tx = activatePort(port.id, redeemedAmt, "truemoney_voucher", {
          sender: senderName,
          voucherHash: hash,
        });

        console.log(`[🧧 TrueMoney OK] port=${port.id} ฿${redeemedAmt} from=${senderName}`);
        return res.json({
          success: true,
          transaction: tx,
          sender: senderName,
          amount: redeemedAmt,
          chargeSeconds: tx.chargeSeconds
        });
      }

      // Handle specific TrueMoney error codes
      const code = data?.status?.code;
      let errMsg = "รับซองของขวัญไม่สำเร็จ";
      if (code === "VOUCHER_OUT_OF_STOCK") errMsg = "ซองของขวัญนี้ถูกรับเงินไปแล้ว หรือซองหมดอายุ";
      else if (code === "VOUCHER_NOT_FOUND") errMsg = "ไม่พบซองของขวัญนี้ กรุณาตรวจสอบลิงก์อีกครั้ง";
      else if (code === "CANNOT_GET_OWN_VOUCHER") errMsg = "ไม่สามารถรับซองของขวัญของตนเองได้";
      else if (code === "TARGET_USER_REDEEMED") errMsg = "คุณได้รับซองของขวัญนี้ไปแล้ว";
      else if (data?.status?.message) errMsg = `TrueMoney: ${data.status.message}`;

      return res.status(400).json({ error: errMsg, code });
    });
  } catch(e) {
    return res.status(500).json({ error: "เกิดข้อผิดพลาดในการประมวลผล: " + e.message });
  }
});

/**
 * POST /api/coin/insert  (จากตัวรับเหรียญ ESP32 เท่านั้น — ต้องมี Hardware Secret)
 * Body: { portId, amount }
 * Headers: X-ESP32-Secret
 */
app.post("/api/coin/insert", requireEsp32Auth, limiterCoin, (req, res) => {
  const port = getPort(req.body.portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (expirePaymentSession(port)) return res.status(410).json({ error: "หมดเวลาชำระเงิน กรุณาเริ่มรายการใหม่" });
  if (port.status !== "pending_payment" || port.paymentSession?.method !== "coin") {
    return res.status(409).json({ error: "พอร์ตนี้ไม่ได้รอการหยอดเหรียญ" });
  }

  const amount = Number(req.body.amount || 0);
  console.log(`[🪙 Coin] port=${port.id} ฿${amount}`);
  if (!Number.isFinite(amount) || amount % 5 !== 0 || amount < port.paymentSession.amount) {
    return res.status(422).json({
      success: false,
      reason: "AMOUNT_TOO_LOW",
      message: `❌ ยอดเหรียญ ฿${amount} ไม่พอหรือไม่ถูกต้อง (ต้องการ ฿${port.paymentSession.amount})`,
    });
  }

  const tx = activatePort(port.id, port.paymentSession.amount, "coin", {
    coinsInserted: amount,
  });
  res.json({ success: true, transaction: tx, coinsInserted: amount });
});

/**
 * POST /api/payment/cancel
 * Body: { portId, sessionId }
 * ป้องกัน User A กดยกเลิกรายการของ User B
 */
app.post("/api/payment/cancel", (req, res) => {
  const { portId, sessionId } = req.body;
  const port = getPort(portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (!port.paymentSession) return res.json({ success: true, message: "ไม่มี session ที่ค้างอยู่" });

  // ตรวจสอบสิทธิ์ความเป็นเจ้าของ session
  if (sessionId && port.paymentSession.id && port.paymentSession.id !== sessionId) {
    return res.status(403).json({ error: "ไม่อนุญาต: รหัส session ไม่ถูกต้อง ไม่สามารถยกเลิกรายการของผู้อื่นได้" });
  }

  clearSession(port.id);
  res.json({ success: true });
});

// ─── Admin ────────────────────────────────────────────────────────────────────

// Rate limiting for admin login (ป้องกัน Brute-Force PIN)
const loginAttempts = new Map(); // ip -> { count, lockUntil }

// POST /api/admin/login — { username, password } → { token }
app.post("/api/admin/login", (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || "local";
  const nowMs = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };

  const { username, password, pin } = req.body;
  const validUser = !username || ["admin", "supakit", "owner"].includes(String(username).toLowerCase().trim());
  const inputPass = String(password || pin || "").trim();

  // ตรวจสอบความถูกต้องด้วย bcrypt hash เท่านั้น (ไม่มี hardcoded password)
  const validPass = inputPass && bcrypt.compareSync(inputPass, CFG.adminPinHash);

  if (validUser && validPass) {
    loginAttempts.delete(ip);
    const token = jwt.sign({ role: "admin", user: username || "admin" }, CFG.jwtSecret, { expiresIn: "8h" });
    console.log(`[🔐 Admin] Login success: ${username || "admin"}`);
    return res.json({ success: true, token, username: username || "admin" });
  }

  if (rec.lockUntil > nowMs) {
    const remainSec = Math.ceil((rec.lockUntil - nowMs) / 1000);
    return res.status(429).json({ error: `ใส่รหัสผิดเกินจำนวน กรุณารอ ${remainSec} วินาที` });
  }

  rec.count += 1;
  if (rec.count >= 5) {
    rec.lockUntil = nowMs + 5 * 60 * 1000; // ล็อก 5 นาที
    rec.count = 0;
    loginAttempts.set(ip, rec);
    return res.status(429).json({ error: "ใส่รหัสผิดเกิน 5 ครั้ง บัญชีถูกระงับชั่วคราว 5 นาที" });
  }
  loginAttempts.set(ip, rec);
  return res.status(401).json({ error: `ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (เหลือโอกาส ${5 - rec.count} ครั้ง)` });
});



// GET /api/ping or /api/health — Keep-Alive & Uptime Check
app.get(["/api/ping", "/api/health"], (_, res) => {
  const activeCount = Object.values(state.ports).filter(p => p.status === "in-use").length;
  res.json({
    status: "ok",
    system: "Smart USB Charger",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: now(),
    activePorts: activeCount,
    totalVisits: (state.visits || []).length,
    easyslip: !!CFG.easyslipKey,
  });
});

// POST /api/stats/visit — Record pageview visit
app.post("/api/stats/visit", (req, res) => {
  if (!state.visits) state.visits = [];
  const v = {
    timestamp: now(),
    ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "local").toString().slice(0, 45),
  };
  state.visits.push(v);
  if (state.visits.length > 3000) state.visits = state.visits.slice(-3000);
  saveState();
  res.json({ success: true, totalVisits: state.visits.length });
});

// GET /api/admin/dashboard — full data (admin only)
app.get("/api/admin/dashboard", requireAdmin, (_, res) => {
  res.json({
    summary: summary(),
    ports: Object.values(state.ports),
    transactions: state.transactions.slice(0, 100),
    visits: state.visits || [],
    config: {
      promptpayPhone: CFG.promptpayPhone,
      bankName: CFG.bankName,
      bankAccount: CFG.bankAccount,
      bankAccountName: CFG.bankAccountName,
      secondsPerBaht: CFG.secondsPerBaht,
      easyslipEnabled: !!CFG.easyslipKey,
      supportPhone: CFG.supportPhone,
      supportLine: CFG.supportLine,
      supportLocation: CFG.supportLocation,
    },
    lastEsp32: state.lastEsp32,
    updatedAt: state.updatedAt,
  });
});

// POST /api/admin/config — update settings (admin only)
app.post("/api/admin/config", requireAdmin, (req, res) => {
  const { promptpayPhone, truemoneyPhone, bankName, bankAccount, bankAccountName, secondsPerBaht, easyslipKey, supportPhone, supportLine, supportLocation } = req.body;
  if (promptpayPhone !== undefined) CFG.promptpayPhone = promptpayPhone.trim();
  if (truemoneyPhone !== undefined) CFG.truemoneyPhone = truemoneyPhone.trim();
  if (bankName !== undefined) CFG.bankName = bankName.trim();
  if (bankAccount !== undefined) CFG.bankAccount = bankAccount.trim();
  if (bankAccountName !== undefined) CFG.bankAccountName = bankAccountName.trim();
  if (secondsPerBaht !== undefined) CFG.secondsPerBaht = Number(secondsPerBaht) || 180;
  if (easyslipKey !== undefined && easyslipKey.trim()) CFG.easyslipKey = easyslipKey.trim();
  if (supportPhone !== undefined) CFG.supportPhone = supportPhone.trim();
  if (supportLine !== undefined) CFG.supportLine = supportLine.trim();
  if (supportLocation !== undefined) CFG.supportLocation = supportLocation.trim();
  
  saveState();
  console.log(`[⚙️ Admin] Updated config: phone=${CFG.promptpayPhone} tmn=${CFG.truemoneyPhone} rate=${CFG.secondsPerBaht}s loc=${CFG.supportLocation}`);
  res.json({
    success: true,
    message: "บันทึกการตั้งค่าระบบเรียบร้อย",
    config: {
      promptpayPhone: CFG.promptpayPhone,
      truemoneyPhone: CFG.truemoneyPhone,
      bankName: CFG.bankName,
      bankAccount: CFG.bankAccount,
      bankAccountName: CFG.bankAccountName,
      secondsPerBaht: CFG.secondsPerBaht,
      easyslipEnabled: !!CFG.easyslipKey,
      supportPhone: CFG.supportPhone,
      supportLine: CFG.supportLine,
      supportLocation: CFG.supportLocation,
    }
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

app.get("/api/esp32/command", requireEsp32Auth, (_, res) => {
  const relays = {};
  Object.values(state.ports).forEach((p) => {
    relays[p.id] = { gpio: p.relayGpio, on: p.relayOn, isPaused: !!p.isPaused, remainingSeconds: p.remainingSeconds };
  });
  res.json({ relays, updatedAt: state.updatedAt });
});

app.post("/api/esp32/report", requireEsp32Auth, (req, res) => {
  state.lastEsp32 = { ...req.body, receivedAt: now() };
  state.updatedAt = now();
  res.json({ success: true });
});

// ─── ISSUES & SUPPORT TICKETS ────────────────────────────────────────────────
const ISSUES_FILE = path.join(DATA_DIR, "issues.json");

const DEFAULT_SERVER_ISSUES = [
  {
    id: "ISSUE-1001",
    createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
    category: "coin",
    categoryLabel: "ระบบรับเงิน (หยอดเหรียญ)",
    portId: "usb-a-1",
    portLabel: "USB-A 1",
    amount: 10,
    contact: "081-999-xxxx",
    description: "หยอดเหรียญ 10 บาทแล้วเครื่องไม่อ่านเวลา พอร์ตไม่ขึ้นกำลังใช้งานครับ",
    imageUrl: "",
    status: "resolved",
    reply: {
      adminName: "ผู้ดูแลระบบ (Admin)",
      message: "ตรวจสอบบันทึกเซ็นเซอร์แล้วพบเหรียญติดในราง ได้ทำการเปิดเวลาชดเชยให้ที่พอร์ต USB-A 1 เรียบร้อย 30 นาที และทำความสะอาดรางเหรียญเรียบร้อยครับ หากต้องการรับเงินคืนสามารถติดต่อได้ที่ห้องคอมพิวเตอร์ อาคาร 1 ครับ",
      repliedAt: new Date(Date.now() - 3600000 * 20).toISOString(),
      isPublic: true
    }
  },
  {
    id: "ISSUE-1002",
    createdAt: new Date(Date.now() - 3600000 * 8).toISOString(),
    category: "transfer",
    categoryLabel: "ระบบรับเงิน (โอนเงิน / QR)",
    portId: "usb-c-1",
    portLabel: "USB-C 1",
    amount: 5,
    contact: "Line: student_test",
    description: "สแกนจ่ายเงินผ่านพร้อมเพย์แล้ว สลิปไม่ผ่านขึ้นว่า 'ไม่พบ QR ในรูป' ครับ เงินตัดไปแล้ว 5 บาท",
    imageUrl: "",
    status: "resolved",
    reply: {
      adminName: "ผู้ดูแลระบบ (Admin)",
      message: "แนะนำให้ใช้รูปบันทึกสลิปต้นฉบับจากแอปธนาคารโดยตรง ไม่ครอปหรือแคปจอจน QR แตกครับ ทั้งนี้แอดมินได้ตรวจสอบยอดเงิน ฿5 เข้าบัญชีแล้ว จึงสั่งเปิดจ่ายไฟที่ช่อง USB-C 1 ให้ทันทีเรียบร้อยครับ ขอบคุณที่แจ้งปัญหาครับ",
      repliedAt: new Date(Date.now() - 3600000 * 7).toISOString(),
      isPublic: true
    }
  },
  {
    id: "ISSUE-1003",
    createdAt: new Date(Date.now() - 3600000 * 3).toISOString(),
    category: "power",
    categoryLabel: "อุปกรณ์และสายชาร์จ",
    portId: "usb-c-2",
    portLabel: "USB-C 2",
    amount: 10,
    contact: "095-123-xxxx",
    description: "หัวสายชาร์จ Type-C หลวม เสียบแล้วไฟเข้าๆ ออกๆ ครับ",
    imageUrl: "",
    status: "pending",
    reply: null
  }
];

function loadIssuesFile() {
  try {
    if (fs.existsSync(ISSUES_FILE)) {
      const data = JSON.parse(fs.readFileSync(ISSUES_FILE, "utf8"));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch(_) {}
  try {
    fs.writeFileSync(ISSUES_FILE, JSON.stringify(DEFAULT_SERVER_ISSUES, null, 2), "utf8");
  } catch(_) {}
  return DEFAULT_SERVER_ISSUES;
}

function saveIssuesFile(issues) {
  try {
    fs.writeFileSync(ISSUES_FILE, JSON.stringify(issues, null, 2), "utf8");
  } catch(_) {}
}

app.get("/api/issues", async (req, res) => {
  const issues = loadIssuesFile();
  const auth = req.headers.authorization;
  let isAdmin = false;
  if (auth && auth.startsWith("Bearer ")) {
    const bearer = auth.slice(7).trim();
    try {
      const decoded = jwt.verify(bearer, CFG.jwtSecret);
      if (decoded && decoded.role === "admin") isAdmin = true;
    } catch(_) {}

    if (!isAdmin && fbAdmin && fbAdmin.apps.length) {
      try {
        const decodedFb = await fbAdmin.auth().verifyIdToken(bearer);
        if (decodedFb && decodedFb.email && db) {
          const whiteDoc = await db.collection("admin_whitelist").doc(decodedFb.email.toLowerCase()).get();
          if (whiteDoc.exists) isAdmin = true;
        }
      } catch(_) {}
    }
  }
  if (isAdmin) {
    return res.json({ issues });
  }
  const publicIssues = issues.filter(x => x.reply && x.reply.isPublic);
  res.json({ issues: publicIssues });
});

app.post("/api/issues", limiterIssues, (req, res) => {
  const issue = req.body;
  if (!issue || !issue.description) {
    return res.status(400).json({ error: "กรุณาระบุรายละเอียดปัญหา" });
  }
  const issues = loadIssuesFile();

  // Validate and sanitize imageUrl (ป้องกัน Stored XSS)
  let safeImageUrl = "";
  if (issue.imageUrl && typeof issue.imageUrl === "string") {
    const trimmed = issue.imageUrl.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:image/")) {
      safeImageUrl = trimmed.slice(0, 2048);
    }
  }

  const newIssue = {
    id: `ISSUE-${Date.now().toString().slice(-4)}`,
    createdAt: new Date().toISOString(),
    category: String(issue.category || "other").slice(0, 30),
    categoryLabel: String(issue.categoryLabel || "ทั่วไป").slice(0, 50),
    portId: String(issue.portId || "all").slice(0, 20),
    portLabel: String(issue.portLabel || "ทั่วไป").slice(0, 30),
    amount: Number(issue.amount) || 0,
    contact: String(issue.contact || "—").slice(0, 60),
    description: String(issue.description).slice(0, 1000),
    imageUrl: safeImageUrl,
    status: "pending",
    reply: null
  };
  issues.unshift(newIssue);
  if (issues.length > 300) issues.pop();
  saveIssuesFile(issues);
  console.log(`[💬 Issue] New issue created: ${newIssue.id} (${newIssue.category})`);
  res.json({ success: true, issue: newIssue });
});

app.post("/api/issues/:id/reply", requireAdmin, (req, res) => {
  const id = req.params.id;
  const { status, message, isPublic } = req.body;
  const issues = loadIssuesFile();
  const target = issues.find(x => x.id === id);
  if (!target) return res.status(404).json({ error: "Issue not found" });

  target.status = status || target.status;
  target.reply = {
    adminName: "ผู้ดูแลระบบ (Admin)",
    message: message || (status === "resolved" ? "ผู้ดูแลได้ตรวจสอบและดำเนินการแก้ไขเรียบร้อยแล้วครับ" : "กำลังดำเนินการตรวจสอบครับ"),
    repliedAt: new Date().toISOString(),
    isPublic: !!isPublic
  };
  saveIssuesFile(issues);
  console.log(`[💬 Issue] Replied to ${id} (isPublic: ${isPublic})`);
  res.json({ success: true, issue: target });
});

app.delete("/api/issues/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  let issues = loadIssuesFile();
  issues = issues.filter(x => x.id !== id);
  saveIssuesFile(issues);
  console.log(`[💬 Issue] Deleted issue: ${id}`);
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
