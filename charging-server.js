try { require("dotenv").config(); } catch (_) {}

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const express = require("express");
const generatePayload = require("promptpay-qr");
const QRCode = require("qrcode");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const ISSUES_FILE = path.join(DATA_DIR, "issues.json");

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

// ─── Security Headers & CORS ──────────────────────────────────────────────────
const DEFAULT_ALLOWED_ORIGINS = [
  "https://usb-charger-project.web.app",
  "https://usb-charger-project.firebaseapp.com",
  "https://usb-charger.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5000",
  "http://127.0.0.1:5000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function getAllowedOrigins() {
  const raw = String(process.env.ALLOWED_ORIGINS || "").trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  if (raw === "*") return "*";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");

  const origin = req.headers.origin;
  const allowed = getAllowedOrigins();
  if (allowed === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && (allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/.test(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-ESP32-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── Firebase Admin (Auth Verification + Firestore Persistence) ────────────────
let db = null;
let fbAdmin = null;
let firestoreEnabled = false;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "usb-charger-project";

function hasFbApps() {
  if (!fbAdmin) return false;
  const apps = typeof fbAdmin.getApps === "function" ? fbAdmin.getApps() : (fbAdmin.apps || []);
  return apps.length > 0;
}

try {
  fbAdmin = require("firebase-admin");
  if (!hasFbApps()) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      fbAdmin.initializeApp({
        credential: fbAdmin.credential.cert(sa),
        projectId: sa.project_id || PROJECT_ID,
      });
      db = fbAdmin.firestore();
      firestoreEnabled = true;
      console.log("[DB] Firebase Admin + Firestore initialized via FIREBASE_SERVICE_ACCOUNT");
    } else {
      fbAdmin.initializeApp({ projectId: PROJECT_ID });
      console.log("[AUTH] Firebase Admin initialized without service account (Google ID token verification active; Firestore sync disabled until FIREBASE_SERVICE_ACCOUNT is set)");
    }
  } else {
    db = fbAdmin.firestore();
    firestoreEnabled = !!process.env.FIREBASE_SERVICE_ACCOUNT;
  }
} catch (e) {
  console.warn("[DB] Firebase Admin init skipped:", e.message);
}

// ─── Runtime Config (from process.env; zero hardcoded secrets/PII) ─────────────
const DEFAULT_ADMIN_EMAILS = [];

function getEnvAdminEmails() {
  const raw = String(process.env.ADMIN_EMAILS || "").trim();
  const list = raw ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  return new Set(list);
}

const CFG = {
  promptpayPhone:     process.env.PROMPTPAY_PHONE || "",
  truemoneyPhone:     process.env.TRUEMONEY_PHONE || process.env.PROMPTPAY_PHONE || "",
  secondsPerBaht:     Math.max(10, Number(process.env.SECONDS_PER_BAHT || 180)),
  easyslipKey:        process.env.EASYSLIP_API_KEY || "",
  esp32Secret:        process.env.ESP32_SECRET || "",
  bankName:           process.env.BANK_NAME || "",
  bankAccount:        process.env.BANK_ACCOUNT || "",
  bankAccountName:    process.env.BANK_ACCOUNT_NAME || "",
  supportPhone:       process.env.SUPPORT_PHONE || "",
  supportLine:        process.env.SUPPORT_LINE || "@smartcharger",
  supportIg:          process.env.SUPPORT_IG || "",
  supportLocation:    process.env.SUPPORT_LOCATION || "จุดบริการชาร์จไฟอัจฉริยะ",
  sessionExpireMs:    Math.min(600_000, Math.max(30_000, Number(process.env.PAYMENT_SESSION_EXPIRE_SECONDS || 600) * 1000)),
  slipMaxAgeMins:     Math.max(5, Number(process.env.SLIP_MAX_AGE_MINS || 30)),
  allowUnverifiedDev: process.env.ALLOW_UNVERIFIED_DEV_MODE === "true",
  allowLocalDevAdmin: process.env.ALLOW_LOCAL_DEV_ADMIN === "true",
};

// ─── Multer (Slip Image Upload) ───────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("รูปแบบไฟล์ไม่รองรับ (รองรับเฉพาะ JPEG, PNG, GIF, WebP)"), ok);
  },
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (_, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ─── Port Definitions & ESP32 Safety Allowlists ───────────────────────────────
const ALLOWED_RELAY_GPIOS = [25, 26, 27, 33];
const DEFAULT_PORT_GPIO_MAP = {
  "usb-a-1": 26,
  "usb-a-2": 27,
  "usb-c-1": 25,
  "usb-c-2": 33,
};

const PORT_DEFS = [
  { id: "usb-a-1", label: "USB-A 1", type: "USB-A", relayGpio: DEFAULT_PORT_GPIO_MAP["usb-a-1"] },
  { id: "usb-a-2", label: "USB-A 2", type: "USB-A", relayGpio: DEFAULT_PORT_GPIO_MAP["usb-a-2"] },
  { id: "usb-c-1", label: "USB-C 1", type: "USB-C", relayGpio: DEFAULT_PORT_GPIO_MAP["usb-c-1"] },
  { id: "usb-c-2", label: "USB-C 2", type: "USB-C", relayGpio: DEFAULT_PORT_GPIO_MAP["usb-c-2"] },
];

// ─── In-Memory State ──────────────────────────────────────────────────────────
const state = {
  deviceId: "charger01",
  ports: {},
  transactions: [],
  visits: [],
  auditLogs: [],
  pendingApprovals: [],
  usedTransRefs: new Set(),
  usedSlipHashes: new Set(),
  lastEsp32: {
    ip: null,
    lastSeen: null,
    status: "offline",
    rssi: null,
    fwVersion: null,
    partitionLabel: null,
    rollbackSupported: null,
    pollIntervalMs: 2000,
    wifiSsid: null,
    otaPendingVerify: false,
  },
  esp32Control: {
    remoteConfig: {
      configVersion: 1,
      pollIntervalMs: 2000,
      portGpioMap: { ...DEFAULT_PORT_GPIO_MAP },
      updatedAt: null,
      updatedBy: null,
    },
    pendingCommand: null,
    pendingWifi: null,
    otaRelease: null,
  },
  systemLogs: [],
  updatedAt: new Date().toISOString(),
};

PORT_DEFS.forEach((d) => {
  state.ports[d.id] = {
    ...d,
    status: "available", // available | pending_payment | in-use
    relayOn: false,
    isPaused: false,
    paymentSession: null,
    currentTx: null,
    remainingSeconds: 0,
    totalSeconds: 0,
  };
});

// ─── Cryptographic Random ID Helpers ──────────────────────────────────────────
function generateRandomId(prefix, existingList = []) {
  const existing = new Set(existingList);
  for (let i = 0; i < 12; i += 1) {
    const num = crypto.randomInt(100000, 1000000);
    const id = `${prefix}-${num}`;
    if (!existing.has(id)) return id;
  }
  return `${prefix}-${crypto.randomInt(100000, 1000000)}-${crypto.randomInt(10, 99)}`;
}

function sanitizeTaggedId(val, prefix) {
  if (typeof val !== "string") return null;
  const clean = val.trim().toUpperCase();
  return new RegExp(`^${prefix}-\\d{6,8}$`).test(clean) ? clean : null;
}

const now = () => new Date().toISOString();
const getPort = (id) => state.ports[id] || null;

function maskIp(rawIp) {
  const clean = String(rawIp || "").replace(/^.*:/, "").trim();
  if (!clean) return "unknown";
  if (clean.includes(".")) {
    const parts = clean.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }
  return clean.slice(0, 16);
}

function parseDeviceType(input, ua = "") {
  if (typeof input === "string" && input.trim()) return input.trim().slice(0, 40);
  const s = String(ua || "");
  if (/iPhone|iPad|iOS/i.test(s)) return "Mobile (iOS)";
  if (/Android/i.test(s)) return "Mobile (Android)";
  if (/Mobile/i.test(s)) return "Mobile";
  if (/Windows|Macintosh|Linux/i.test(s)) return "Desktop";
  return "Web Browser";
}

function addSystemLog(source, level, message, details = null) {
  const entry = {
    id: generateRandomId("LOG", state.systemLogs.map((l) => l.id)),
    time: new Date().toLocaleTimeString("th-TH", { hour12: false }),
    iso: now(),
    source: String(source || "SYS").toUpperCase(),
    level: level || "info",
    message: String(message || ""),
    details,
  };
  state.systemLogs.unshift(entry);
  if (state.systemLogs.length > 100) state.systemLogs.pop();
  return entry;
}

function addAuditLog(adminUser, action, target, details = {}) {
  const entry = {
    id: generateRandomId("AUD", state.auditLogs.map((a) => a.id)),
    timestamp: now(),
    adminEmail: adminUser?.email || adminUser?.user || "system",
    provider: adminUser?.provider || "firebase",
    action: String(action || "UNKNOWN"),
    target: String(target || "system"),
    details,
  };
  state.auditLogs.unshift(entry);
  if (state.auditLogs.length > 300) state.auditLogs.pop();
  addSystemLog("ADMIN", "info", `${entry.adminEmail}: ${entry.action} (${entry.target})`);
  if (firestoreEnabled && db) {
    db.collection("audit_logs").doc(entry.id).set(entry).catch((e) => {
      console.warn("[DB] Failed writing audit_log:", e.message);
    });
  }
  saveState();
  return entry;
}

// ─── Firestore & Disk Persistence ─────────────────────────────────────────────
async function pushToFirestore(publicPayload, privateStatePayload) {
  if (!firestoreEnabled || !db) return;
  try {
    await db.collection("charger").doc("charger01").set(publicPayload, { merge: true });
    if (privateStatePayload) {
      await db.collection("charger_private").doc("state").set(privateStatePayload, { merge: true });
    }
  } catch (e) {
    console.warn("[DB] Firestore push error:", e.message);
  }
}

function syncTxToFirestore(tx) {
  if (!firestoreEnabled || !db || !tx?.id) return;
  db.collection("transactions").doc(tx.id).set(tx, { merge: true }).catch((e) => {
    console.warn("[DB] Transaction sync warning:", e.message);
  });
}

function syncVisitToFirestore(visit) {
  if (!firestoreEnabled || !db || !visit?.id) return;
  db.collection("visits").doc(visit.id).set(visit, { merge: true }).catch((e) => {
    console.warn("[DB] Visit sync warning:", e.message);
  });
}

function syncPendingToFirestore(pending) {
  if (!firestoreEnabled || !db || !pending?.id) return;
  const { imageDataUrl, ...safeMeta } = pending;
  db.collection("pending_approvals").doc(pending.id).set(safeMeta, { merge: true }).catch((e) => {
    console.warn("[DB] Pending sync warning:", e.message);
  });
}

function buildPublicPortsSnapshot() {
  return Object.values(state.ports).map((p) => ({
    id: p.id,
    label: p.label,
    type: p.type,
    relayGpio: p.relayGpio,
    status: p.status,
    relayOn: p.relayOn,
    isPaused: !!p.isPaused,
    remainingSeconds: p.remainingSeconds,
    totalSeconds: p.currentTx?.chargeSeconds || (p.remainingSeconds > 0 ? p.remainingSeconds : 0),
    currentTx: p.currentTx ? {
      id: p.currentTx.id,
      payerId: p.currentTx.payerId,
      amount: p.currentTx.amount,
      chargeSeconds: p.currentTx.chargeSeconds,
      method: p.currentTx.method,
    } : null,
    hasSession: !!p.paymentSession,
    sessionMethod: p.paymentSession?.method || null,
    sessionExpiresAt: p.paymentSession?.expiresAt || null,
    sessionClientId: p.paymentSession?.clientId || null,
  }));
}

function getRuntimePublicConfig() {
  return {
    secondsPerBaht: CFG.secondsPerBaht,
    supportPhone: CFG.supportPhone,
    supportLine: CFG.supportLine,
    supportIg: CFG.supportIg,
    supportLocation: CFG.supportLocation,
    easyslipEnabled: !!CFG.easyslipKey,
    promptpayConfigured: !!CFG.promptpayPhone,
    bankConfigured: !!(CFG.bankAccount && CFG.bankName),
    truemoneyConfigured: !!CFG.truemoneyPhone,
  };
}

function getRuntimeAdminConfig() {
  return {
    promptpayPhone: CFG.promptpayPhone,
    truemoneyPhone: CFG.truemoneyPhone,
    bankName: CFG.bankName,
    bankAccount: CFG.bankAccount,
    bankAccountName: CFG.bankAccountName,
    secondsPerBaht: CFG.secondsPerBaht,
    easyslipEnabled: !!CFG.easyslipKey,
    supportPhone: CFG.supportPhone,
    supportLine: CFG.supportLine,
    supportIg: CFG.supportIg,
    supportLocation: CFG.supportLocation,
  };
}

function computeVisitStats() {
  const visits = state.visits || [];
  const uniqueUsers = new Set();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  let todayVisits = 0;

  visits.forEach((v) => {
    if (v.visitorId) uniqueUsers.add(v.visitorId);
    if (v.timestamp && new Date(v.timestamp).getTime() >= todayMs) {
      todayVisits += 1;
    }
  });

  return {
    totalVisits: visits.length,
    todayVisits,
    uniqueVisitors: uniqueUsers.size,
  };
}

function findActiveChargingPort() {
  return Object.values(state.ports).find(
    (p) => p.relayOn || p.status === "in-use" || p.status === "pending_payment"
  ) || null;
}

function areAllRelaysOff() {
  return Object.values(state.ports).every((p) => !p.relayOn);
}

function validatePortGpioMap(inputMap) {
  if (!inputMap || typeof inputMap !== "object") {
    return { valid: false, error: "ข้อมูล portGpioMap ไม่ถูกต้อง" };
  }
  const normalized = {};
  const usedPins = new Set();
  for (const def of PORT_DEFS) {
    const pin = Number(inputMap[def.id]);
    if (!Number.isInteger(pin) || !ALLOWED_RELAY_GPIOS.includes(pin)) {
      return {
        valid: false,
        error: `พิน GPIO ของ ${def.label} (${inputMap[def.id]}) ไม่อยู่ในรายการที่อนุญาต (${ALLOWED_RELAY_GPIOS.join(", ")})`,
      };
    }
    if (usedPins.has(pin)) {
      return { valid: false, error: `พิน GPIO ${pin} ซ้ำกันไม่ได้ ต้องกำหนดไม่ซ้ำทั้ง 4 พอร์ต` };
    }
    usedPins.add(pin);
    normalized[def.id] = pin;
  }
  return { valid: true, map: normalized };
}

function applyPortGpioMap(map) {
  PORT_DEFS.forEach((def) => {
    if (state.ports[def.id] && Number.isInteger(map?.[def.id])) {
      state.ports[def.id].relayGpio = map[def.id];
    }
  });
}

function validateOtaHttpsUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s || s.length > 500) {
    return { valid: false, error: "URL ไฟล์เฟิร์มแวร์ต้องไม่ว่างและยาวไม่เกิน 500 ตัวอักษร" };
  }
  let parsed;
  try {
    parsed = new URL(s);
  } catch (_) {
    return { valid: false, error: "รูปแบบ URL ไม่ถูกต้อง" };
  }
  if (parsed.protocol !== "https:") {
    return { valid: false, error: "URL ไฟล์เฟิร์มแวร์ OTA ต้องใช้ HTTPS เท่านั้น (แนะนำ Firebase Storage)" };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  ) {
    return { valid: false, error: "ไม่อนุญาตให้ใช้ URL ภายในเครือข่าย/localhost สำหรับ OTA" };
  }
  return { valid: true, url: parsed.toString() };
}

function sanitizeEsp32ControlForAdmin() {
  const ctrl = state.esp32Control || {};
  const nowMs = Date.now();
  const cmd = ctrl.pendingCommand && (!ctrl.pendingCommand.expiresAt || new Date(ctrl.pendingCommand.expiresAt).getTime() > nowMs)
    ? ctrl.pendingCommand
    : null;
  const wifi = ctrl.pendingWifi && (!ctrl.pendingWifi.expiresAt || new Date(ctrl.pendingWifi.expiresAt).getTime() > nowMs)
    ? {
        wifiCmdId: ctrl.pendingWifi.wifiCmdId,
        ssid: ctrl.pendingWifi.ssid,
        timeoutSec: ctrl.pendingWifi.timeoutSec,
        requestedAt: ctrl.pendingWifi.requestedAt,
        requestedBy: ctrl.pendingWifi.requestedBy,
        expiresAt: ctrl.pendingWifi.expiresAt,
      }
    : null;
  return {
    remoteConfig: ctrl.remoteConfig,
    pendingCommand: cmd,
    pendingWifi: wifi,
    otaRelease: ctrl.otaRelease || null,
    allowedGpios: ALLOWED_RELAY_GPIOS,
  };
}

function applySavedEsp32Control(saved) {
  if (!saved || typeof saved !== "object") return;
  if (saved.remoteConfig && typeof saved.remoteConfig === "object") {
    const rc = saved.remoteConfig;
    const pollMs = Number(rc.pollIntervalMs);
    if (Number.isInteger(pollMs) && pollMs >= 1000 && pollMs <= 10000) {
      state.esp32Control.remoteConfig.pollIntervalMs = pollMs;
    }
    if (Number.isInteger(Number(rc.configVersion)) && Number(rc.configVersion) >= 1) {
      state.esp32Control.remoteConfig.configVersion = Number(rc.configVersion);
    }
    const gpioCheck = validatePortGpioMap(rc.portGpioMap);
    if (gpioCheck.valid) {
      state.esp32Control.remoteConfig.portGpioMap = gpioCheck.map;
      applyPortGpioMap(gpioCheck.map);
    }
    if (rc.updatedAt) state.esp32Control.remoteConfig.updatedAt = rc.updatedAt;
    if (rc.updatedBy) state.esp32Control.remoteConfig.updatedBy = rc.updatedBy;
  }
  if (saved.otaRelease && typeof saved.otaRelease === "object" && saved.otaRelease.otaId) {
    state.esp32Control.otaRelease = saved.otaRelease;
  }
}

function saveState() {
  try {
    const ports = buildPublicPortsSnapshot();
    const visitStats = computeVisitStats();

    // Never persist secrets (like easyslipKey, pins, or Wi-Fi passwords) to local disk JSON
    const diskData = {
      transactions: state.transactions.slice(0, 500),
      usedTransRefs: Array.from(state.usedTransRefs).slice(-1000),
      usedSlipHashes: Array.from(state.usedSlipHashes || []).slice(-1000),
      visits: state.visits.slice(-1500),
      auditLogs: state.auditLogs.slice(0, 200),
      pendingApprovals: state.pendingApprovals.map(({ imageDataUrl, ...meta }) => meta).slice(0, 50),
      ports,
      config: {
        promptpayPhone: CFG.promptpayPhone,
        truemoneyPhone: CFG.truemoneyPhone,
        bankName: CFG.bankName,
        bankAccount: CFG.bankAccount,
        bankAccountName: CFG.bankAccountName,
        secondsPerBaht: CFG.secondsPerBaht,
        supportPhone: CFG.supportPhone,
        supportLine: CFG.supportLine,
        supportIg: CFG.supportIg,
        supportLocation: CFG.supportLocation,
      },
      esp32Control: {
        remoteConfig: state.esp32Control.remoteConfig,
        otaRelease: state.esp32Control.otaRelease,
      },
      updatedAt: state.updatedAt,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(diskData, null, 2), "utf8");

    const publicPayload = {
      ports,
      ...getRuntimePublicConfig(),
      config: getRuntimePublicConfig(),
      stats: {
        totalVisits: visitStats.totalVisits,
        todayVisits: visitStats.todayVisits,
        uniqueVisitors: visitStats.uniqueVisitors,
        totalTransactions: state.transactions.length,
      },
      updatedAt: state.updatedAt,
      deviceId: state.deviceId,
      esp32: state.lastEsp32,
      systemLogs: (state.systemLogs || []).slice(0, 30),
    };

    const privatePayload = {
      ports,
      usedTransRefs: Array.from(state.usedTransRefs).slice(-1000),
      usedSlipHashes: Array.from(state.usedSlipHashes || []).slice(-1000),
      config: diskData.config,
      esp32Control: diskData.esp32Control,
      updatedAt: state.updatedAt,
    };

    pushToFirestore(publicPayload, privatePayload);
  } catch (e) {
    console.error("[ERR] saveState failed:", e.message);
  }
}

function applySavedPorts(savedPorts, updatedAt) {
  if (!Array.isArray(savedPorts)) return;
  const lastTime = updatedAt ? new Date(updatedAt).getTime() : 0;
  const passedSeconds = lastTime ? Math.max(0, Math.floor((Date.now() - lastTime) / 1000)) : 0;

  savedPorts.forEach((saved) => {
    const p = state.ports[saved.id];
    if (!p) return;
    p.status = saved.status || "available";
    p.relayOn = !!saved.relayOn;
    p.isPaused = !!saved.isPaused;
    p.remainingSeconds = Number(saved.remainingSeconds) || 0;
    p.totalSeconds = Number(saved.totalSeconds) || p.remainingSeconds;
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
  });
}

function applySavedConfig(cfgObj) {
  if (!cfgObj || typeof cfgObj !== "object") return;
  if (cfgObj.promptpayPhone !== undefined && cfgObj.promptpayPhone !== "") CFG.promptpayPhone = String(cfgObj.promptpayPhone);
  if (cfgObj.truemoneyPhone !== undefined && cfgObj.truemoneyPhone !== "") CFG.truemoneyPhone = String(cfgObj.truemoneyPhone);
  if (cfgObj.bankName !== undefined && cfgObj.bankName !== "") CFG.bankName = String(cfgObj.bankName);
  if (cfgObj.bankAccount !== undefined && cfgObj.bankAccount !== "") CFG.bankAccount = String(cfgObj.bankAccount);
  if (cfgObj.bankAccountName !== undefined && cfgObj.bankAccountName !== "") CFG.bankAccountName = String(cfgObj.bankAccountName);
  if (cfgObj.secondsPerBaht) CFG.secondsPerBaht = Math.max(10, Number(cfgObj.secondsPerBaht));
  if (cfgObj.supportPhone !== undefined) CFG.supportPhone = String(cfgObj.supportPhone);
  if (cfgObj.supportLine !== undefined) CFG.supportLine = String(cfgObj.supportLine);
  if (cfgObj.supportIg !== undefined) CFG.supportIg = String(cfgObj.supportIg);
  if (cfgObj.supportLocation !== undefined) CFG.supportLocation = String(cfgObj.supportLocation);
}

function loadStateFromDisk() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.transactions)) state.transactions = data.transactions;
    if (Array.isArray(data.usedTransRefs)) state.usedTransRefs = new Set(data.usedTransRefs);
    if (Array.isArray(data.usedSlipHashes)) state.usedSlipHashes = new Set(data.usedSlipHashes);
    if (Array.isArray(data.visits)) state.visits = data.visits;
    if (Array.isArray(data.auditLogs)) state.auditLogs = data.auditLogs;
    if (Array.isArray(data.pendingApprovals)) state.pendingApprovals = data.pendingApprovals;
    applySavedConfig(data.config);
    applySavedEsp32Control(data.esp32Control);
    applySavedPorts(data.ports, data.updatedAt);
    console.log(`[DISK] Loaded ${state.transactions.length} transactions, ${state.visits.length} visits, ${state.usedTransRefs.size} slips`);
  } catch (e) {
    console.error("[DISK] loadStateFromDisk error:", e.message);
  }
}

async function restoreFromFirestore() {
  if (!firestoreEnabled || !db) return;
  try {
    const privSnap = await db.collection("charger_private").doc("state").get();
    if (privSnap.exists) {
      const priv = privSnap.data();
      if (Array.isArray(priv.usedTransRefs)) {
        priv.usedTransRefs.forEach((ref) => state.usedTransRefs.add(ref));
      }
      if (Array.isArray(priv.usedSlipHashes)) {
        priv.usedSlipHashes.forEach((h) => state.usedSlipHashes.add(h));
      }
      applySavedConfig(priv.config);
      applySavedEsp32Control(priv.esp32Control);
      if (state.transactions.length === 0 && Array.isArray(priv.ports)) {
        applySavedPorts(priv.ports, priv.updatedAt);
      }
    }

    const txSnap = await db.collection("transactions").orderBy("createdAt", "desc").limit(200).get();
    if (!txSnap.empty) {
      const merged = new Map();
      state.transactions.forEach((t) => merged.set(t.id, t));
      txSnap.docs.forEach((d) => merged.set(d.id, d.data()));
      state.transactions = Array.from(merged.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 500);
    }

    const visSnap = await db.collection("visits").orderBy("timestamp", "desc").limit(600).get();
    if (!visSnap.empty) {
      const mergedV = new Map();
      state.visits.forEach((v) => mergedV.set(v.id, v));
      visSnap.docs.forEach((d) => mergedV.set(d.id, d.data()));
      state.visits = Array.from(mergedV.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)).slice(-1500);
    }

    const audSnap = await db.collection("audit_logs").orderBy("timestamp", "desc").limit(150).get();
    if (!audSnap.empty) {
      const mergedA = new Map();
      state.auditLogs.forEach((a) => mergedA.set(a.id, a));
      audSnap.docs.forEach((d) => mergedA.set(d.id, d.data()));
      state.auditLogs = Array.from(mergedA.values()).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 300);
    }

    const penSnap = await db.collection("pending_approvals").where("status", "==", "pending").limit(50).get();
    if (!penSnap.empty) {
      const mergedP = new Map();
      state.pendingApprovals.forEach((p) => mergedP.set(p.id, p));
      penSnap.docs.forEach((d) => mergedP.set(d.id, d.data()));
      state.pendingApprovals = Array.from(mergedP.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    console.log(`[DB] Firestore restore complete: ${state.transactions.length} tx, ${state.visits.length} visits, ${state.auditLogs.length} audit logs`);
  } catch (e) {
    console.warn("[DB] Firestore restore warning:", e.message);
  }
}

loadStateFromDisk();

// ─── Port & Transaction Helpers ───────────────────────────────────────────────
function defaultPayerLabel(method) {
  switch (method) {
    case "coin": return "ลูกค้าหยอดเหรียญหน้าตู้";
    case "truemoney": return "ผู้โอน TrueMoney";
    case "truemoney_voucher": return "ผู้ส่งซองของขวัญ TrueMoney";
    case "test": return "ผู้ดูแลระบบ (โหมดทดสอบ)";
    default: return "ผู้โอนผ่านสลิป";
  }
}

function defaultReceiverChannel(method) {
  switch (method) {
    case "coin": return "กล่องรับเหรียญหน้าตู้";
    case "truemoney":
    case "truemoney_voucher":
      return CFG.truemoneyPhone ? `TrueMoney (${maskPhoneForDisplay(CFG.truemoneyPhone)})` : "TrueMoney Wallet";
    case "transfer":
      return CFG.bankAccount ? `${CFG.bankName || "ธนาคาร"} ${maskAccountForDisplay(CFG.bankAccount)}` : "บัญชีธนาคารของตู้";
    case "qr":
      return CFG.promptpayPhone ? `PromptPay (${maskPhoneForDisplay(CFG.promptpayPhone)})` : "PromptPay ของตู้";
    case "test":
      return "ระบบทดสอบหน้าเว็บแอดมิน";
    default:
      return "บัญชีรับชำระของตู้";
  }
}

function maskPhoneForDisplay(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 4) return phone || "—";
  return `xxx-xxx-${digits.slice(-4)}`;
}

function maskAccountForDisplay(acc) {
  const digits = String(acc || "").replace(/\D/g, "");
  if (digits.length < 4) return acc || "—";
  return `xxx-x-x${digits.slice(-4)}`;
}

function createTx(port, amount, method, extra = {}) {
  const createdAt = now();
  const chargeSeconds = extra.testDuration || Math.round(amount * CFG.secondsPerBaht);
  const txId = generateRandomId("TX", state.transactions.map((t) => t.id));
  const payerId = sanitizeTaggedId(extra.visitorId || extra.payerId, "USR") || generateRandomId("USR");

  const tx = {
    id: txId,
    portId: port.id,
    portLabel: port.label,
    portType: port.type,
    amount,
    method,
    chargeSeconds,
    status: "active",
    payerId,
    payerName: extra.sender || defaultPayerLabel(method),
    payerBank: extra.senderBank || "",
    receiverName: extra.receiver || CFG.bankAccountName || "เจ้าของตู้ชาร์จ",
    receiverAccount: extra.receiverAccount || defaultReceiverChannel(method),
    receiverBank: extra.receiverBank || (method === "transfer" ? (CFG.bankName || "ธนาคาร") : ""),
    transRef: extra.transRef || null,
    paidAt: extra.slipDate || createdAt,
    createdAt,
    endedAt: null,
    endedReason: null,
    usedSeconds: null,
    approvedBy: extra.approvedBy || null,
    verification: {
      isDev: !!extra.isDev,
      isTest: !!extra.isTest,
      voucherHash: extra.voucherHash || null,
      coinsInserted: extra.coinsInserted || null,
    },
  };

  state.transactions.unshift(tx);
  state.transactions = state.transactions.slice(0, 500);
  syncTxToFirestore(tx);
  saveState();
  return tx;
}

function activatePort(portId, amount, method, extra = {}) {
  const port = getPort(portId);
  if (!port) return null;

  // Atomic state guard: prevent race conditions from double activation
  if (port.status === "in-use" && !extra.allowTopUp) {
    console.warn(`[RELAY-GUARD] Port ${portId} is already in-use. Blocking concurrent activation.`);
    return null;
  }

  const sessionVisitorId = port.paymentSession?.visitorId || extra.visitorId || null;
  const tx = createTx(port, amount, method, { ...extra, visitorId: sessionVisitorId });

  if (port.status === "in-use" && extra.allowTopUp) {
    port.remainingSeconds += tx.chargeSeconds;
    port.totalSeconds += tx.chargeSeconds;
    port.isPaused = false;
    port.relayOn = true;
    port.paymentSession = null;
    state.updatedAt = now();
    saveState();
    console.log(`[RELAY] Topped up port=${portId} +${amount}B (${tx.chargeSeconds}s) newRemaining=${port.remainingSeconds}s`);
    addSystemLog("RELAY", "success", `พอร์ต ${port.label} เติมเวลาชาร์จ +${amount} บาท (+${Math.round(tx.chargeSeconds / 60)} นาที) [${tx.id}]`);
    return tx;
  }

  port.status = "in-use";
  port.relayOn = true;
  port.isPaused = false;
  port.paymentSession = null;
  port.currentTx = tx;
  port.remainingSeconds = tx.chargeSeconds;
  port.totalSeconds = tx.chargeSeconds;
  state.updatedAt = now();
  saveState();

  console.log(`[RELAY] Activated port=${portId} amount=${amount} method=${method} tx=${tx.id} payer=${tx.payerId}`);
  addSystemLog("RELAY", "success", `พอร์ต ${port.label} เริ่มจ่ายไฟ ${amount} บาท (${Math.round(tx.chargeSeconds / 60)} นาที) [${tx.id} / ${tx.payerId}]`);
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
    const txInList = state.transactions.find((t) => t.id === port.currentTx.id);
    if (txInList) {
      Object.assign(txInList, {
        status: "finished",
        endedAt: port.currentTx.endedAt,
        endedReason: reason,
        usedSeconds: port.currentTx.usedSeconds,
      });
    }
    syncTxToFirestore(port.currentTx);
  }
  port.status = "available";
  port.relayOn = false;
  port.isPaused = false;
  port.currentTx = null;
  port.remainingSeconds = 0;
  port.totalSeconds = 0;
  state.updatedAt = now();
  saveState();
  const reasonText = reason === "time_up" ? "ครบเวลาชาร์จแล้ว" : (reason === "early_stop" ? "ผู้ใช้หยุดชาร์จก่อนเวลา" : "คำสั่งผู้ดูแล");
  addSystemLog("RELAY", "info", `พอร์ต ${port.label} ตัดไฟ (${reasonText})`);
  console.log(`[RELAY] Stopped port=${portId} reason=${reason}`);
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
  console.log(`[SESSION] Expired port=${port.id}`);
  clearSession(port.id);
  return true;
}

function summary() {
  const txs = state.transactions || [];
  const revenue = txs.filter((t) => t.method !== "test").reduce((s, t) => s + Number(t.amount || 0), 0);
  const visitStats = computeVisitStats();
  return {
    revenue: Math.round(revenue * 100) / 100,
    transactionCount: txs.length,
    activeCount: txs.filter((t) => t.status === "active").length,
    finishedCount: txs.filter((t) => t.status === "finished").length,
    totalVisits: visitStats.totalVisits,
    todayVisits: visitStats.todayVisits,
    uniqueVisitors: visitStats.uniqueVisitors,
    pendingApprovalsCount: (state.pendingApprovals || []).filter((p) => p.status === "pending").length,
    byMethod: txs.reduce((acc, t) => {
      acc[t.method] = (acc[t.method] || 0) + Number(t.amount || 0);
      return acc;
    }, {}),
  };
}

// ─── Background Timers ────────────────────────────────────────────────────────
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

setInterval(() => {
  Object.values(state.ports).forEach((p) => {
    if (p.status === "pending_payment" && p.paymentSession) {
      expirePaymentSession(p);
    }
  });
}, 1000);

// ─── EasySlip Verification ────────────────────────────────────────────────────
function extractPartyName(party, fallback = "") {
  return (
    party?.account?.name?.th ||
    party?.account?.name?.en ||
    party?.name ||
    party?.displayName ||
    fallback
  );
}

function extractBankName(party) {
  return party?.bank?.short || party?.bank?.name || "";
}

async function verifySlip(imageBuffer, mimetype, expectedAmount) {
  const slipHash = crypto.createHash("sha256").update(imageBuffer).digest("hex");
  if (state.usedSlipHashes && state.usedSlipHashes.has(slipHash)) {
    return { valid: false, reason: "DUPLICATE_SLIP", message: "รูปสลิปนี้ถูกใช้งานในระบบไปแล้ว" };
  }

  if (!CFG.easyslipKey) {
    if (CFG.allowUnverifiedDev) {
      console.warn("[SLIP] Explicit dev mode (ALLOW_UNVERIFIED_DEV_MODE=true) — bypass active");
      return {
        valid: true,
        isDev: true,
        amount: expectedAmount,
        transRef: generateRandomId("DEV"),
        sender: "โหมดทดสอบ (ยังไม่ใส่คีย์ EasySlip)",
        senderBank: "DEV",
        receiver: CFG.bankAccountName || "เจ้าของตู้ชาร์จ",
        receiverAccount: defaultReceiverChannel("qr"),
        receiverBank: CFG.bankName || "PromptPay",
        slipDate: now(),
      };
    }
    return {
      valid: false,
      needsManualReview: true,
      reason: "EASYSLIP_NOT_CONFIGURED",
      message: "ระบบตรวจสลิปอัตโนมัติยังไม่ได้ตั้งค่าคีย์ ส่งเข้าคิวรอผู้ดูแลตรวจแทน",
    };
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
      signal: AbortSignal.timeout(15000),
    });
    result = await resp.json();
  } catch (err) {
    console.warn(`[SLIP] EasySlip connection error: ${err.message}`);
    return {
      valid: false,
      needsManualReview: true,
      reason: "EASYSLIP_UNAVAILABLE",
      message: "ระบบตรวจสลิปขัดข้องชั่วคราว ส่งคำขอเข้าคิวรอผู้ดูแลอนุมัติแล้ว",
    };
  }

  if (!result.success) {
    const code = result.error?.code || "UNKNOWN";
    if (["SERVICE_EXPIRED", "SUBSCRIPTION_EXPIRED", "INTERNAL_ERROR", "SERVER_ERROR", "QUOTA_EXCEEDED"].includes(code)) {
      console.warn(`[SLIP] EasySlip ${code} — queuing for manual approval`);
      return {
        valid: false,
        needsManualReview: true,
        reason: code,
        message: "ระบบตรวจสลิปอัตโนมัติไม่พร้อมใช้งาน ส่งเข้าคิวรอผู้ดูแลอนุมัติแล้ว",
      };
    }
    const codeMap = {
      SLIP_NOT_FOUND: "ไม่พบ QR Code ในรูป กรุณาถ่ายให้เห็น QR ชัดเจน",
      IMAGE_SIZE_TOO_LARGE: "รูปขนาดใหญ่เกินไป (สูงสุด 4 MB)",
      INVALID_IMAGE_FORMAT: "รูปแบบไฟล์ไม่ถูกต้อง",
      SLIP_PENDING: "สลิปอยู่ระหว่างรอตรวจสอบจากธนาคาร กรุณารอสักครู่แล้วลองใหม่",
    };
    return {
      valid: false,
      needsManualReview: false,
      reason: code,
      message: codeMap[code] || result.error?.message || "ตรวจสลิปไม่สำเร็จ",
    };
  }

  const data = result.data || {};
  const raw = data.rawSlip || {};

  // 1. Duplicate Slip Check
  if (data.isDuplicate || (raw?.transRef && state.usedTransRefs.has(raw.transRef))) {
    return { valid: false, reason: "DUPLICATE_SLIP", message: "สลิปนี้ถูกใช้งานในระบบไปแล้ว" };
  }

  // 2. Amount Check
  const slipAmount = Number(data.amountInSlip ?? raw?.amount?.amount ?? 0);
  if (slipAmount < expectedAmount) {
    return {
      valid: false,
      reason: "AMOUNT_TOO_LOW",
      message: `จำนวนเงินไม่พอ (ในสลิป ${slipAmount} บาท — ต้องการ ${expectedAmount} บาท)`,
    };
  }

  // 3. Slip Timestamp Age Check
  if (raw?.date) {
    const ageMins = (Date.now() - new Date(raw.date).getTime()) / 60000;
    if (ageMins > CFG.slipMaxAgeMins) {
      return { valid: false, reason: "SLIP_TOO_OLD", message: `สลิปเก่าเกิน ${CFG.slipMaxAgeMins} นาที` };
    }
    if (ageMins < -5) {
      return { valid: false, reason: "SLIP_FUTURE", message: "วันที่หรือเวลาในสลิปไม่ถูกต้อง" };
    }
  }

  // 4. Receiver Verification (PromptPay / Bank Account / Account Name from CFG)
  const receiverProxy = raw?.receiver?.account?.proxy?.account || raw?.receiver?.proxy?.account || "";
  const receiverAcc = raw?.receiver?.account?.bank?.account || raw?.receiver?.account?.account || "";
  const receiverName = extractPartyName(raw?.receiver, "");
  const receiverBank = extractBankName(raw?.receiver);

  const hasReceiverConfigured = !!(CFG.promptpayPhone || CFG.bankAccount || CFG.bankAccountName);
  let receiverMatch = !hasReceiverConfigured;

  if (!receiverMatch && receiverName && CFG.bankAccountName) {
    const normSlipName = receiverName.toLowerCase().replace(/\s+/g, "");
    const firstToken = CFG.bankAccountName.toLowerCase().trim().split(/\s+/)[0];
    if (firstToken && normSlipName.includes(firstToken)) {
      receiverMatch = true;
    }
  }

  if (!receiverMatch && receiverProxy && CFG.promptpayPhone) {
    const proxyDigits = String(receiverProxy).replace(/\D/g, "");
    const cfgDigits = CFG.promptpayPhone.replace(/\D/g, "");
    if (proxyDigits.length >= 4 && cfgDigits.endsWith(proxyDigits.slice(-4))) {
      receiverMatch = true;
    }
  }

  if (!receiverMatch && receiverAcc && CFG.bankAccount) {
    const accDigits = String(receiverAcc).replace(/\D/g, "");
    const cfgAccDigits = CFG.bankAccount.replace(/\D/g, "");
    if (accDigits.length >= 4 && cfgAccDigits.endsWith(accDigits.slice(-4))) {
      receiverMatch = true;
    }
  }

  if (hasReceiverConfigured && (receiverProxy || receiverAcc || receiverName) && !receiverMatch) {
    return { valid: false, reason: "WRONG_RECEIVER", message: "สลิปไม่ได้โอนเข้าบัญชีหรือพร้อมเพย์ของตู้ชาร์จนี้" };
  }

  // Reserve transRef & slipHash to prevent replay attacks
  if (raw?.transRef) {
    state.usedTransRefs.add(raw.transRef);
  }
  if (slipHash) {
    state.usedSlipHashes.add(slipHash);
  }
  saveState();

  return {
    valid: true,
    transRef: raw?.transRef || generateRandomId("SLIP"),
    slipHash,
    amount: slipAmount,
    sender: extractPartyName(raw?.sender, "ผู้โอนผ่านสลิป"),
    senderBank: extractBankName(raw?.sender) || "Bank",
    receiver: receiverName || CFG.bankAccountName || "เจ้าของตู้ชาร์จ",
    receiverAccount: receiverProxy || receiverAcc || defaultReceiverChannel("qr"),
    receiverBank: receiverBank || CFG.bankName || "PromptPay",
    slipDate: raw?.date || now(),
  };
}

// ─── Rate Limiters ────────────────────────────────────────────────────────────
function createRateLimiter({ windowMs, maxRequests, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip || req.socket?.remoteAddress || "local").split(",")[0].trim();
    const nowMs = Date.now();
    const timestamps = (hits.get(ip) || []).filter((t) => nowMs - t < windowMs);
    if (timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((timestamps[0] + windowMs - nowMs) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: message || "คำขอมากเกินไป กรุณารอสักครู่", retryAfterSeconds: retryAfter });
    }
    timestamps.push(nowMs);
    hits.set(ip, timestamps);
    if (hits.size > 2000) {
      for (const [k, arr] of hits.entries()) {
        if (arr.every((t) => nowMs - t >= windowMs)) hits.delete(k);
      }
    }
    next();
  };
}

const limiterIssues        = createRateLimiter({ windowMs: 5 * 60 * 1000,  maxRequests: 8,  message: "แจ้งปัญหาบ่อยเกินไป กรุณารอ 5 นาที" });
const limiterVerifySlip    = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 8,  message: "ตรวจสอบสลิปเกินจำนวนที่กำหนด (สูงสุด 8 ครั้ง/15 นาที)" });
const limiterCoin          = createRateLimiter({ windowMs: 60 * 1000,      maxRequests: 30, message: "คำขอหยอดเหรียญถี่เกินไป" });
const limiterPaymentCreate = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 15, message: "สร้างคำขอชำระเงินบ่อยเกินไป กรุณารอสักครู่" });
const limiterVisit         = createRateLimiter({ windowMs: 60 * 1000,      maxRequests: 30, message: "บันทึกการเข้าชมถี่เกินไป" });

// ─── Hardware Device Auth (ESP32 Header Only) ────────────────────────────────
function safeTimingEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (!bufA.length || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireEsp32Auth(req, res, next) {
  if (!CFG.esp32Secret) {
    return res.status(503).json({ error: "เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า ESP32_SECRET ใน Environment Variables" });
  }
  const provided = String(
    req.headers["x-esp32-secret"] ||
    req.headers["x-device-token"] ||
    req.headers["x-device-secret"] ||
    ""
  ).trim();

  if (!provided || !safeTimingEqual(provided, CFG.esp32Secret)) {
    console.warn(`[ESP32] Auth 403 from ${maskIp(req.headers["x-forwarded-for"] || req.ip)}`);
    return res.status(403).json({ error: "ไม่อนุญาต: รหัสยืนยันตัวตน ESP32 ไม่ถูกต้องหรือไม่ครบถ้วน" });
  }
  next();
}

// ─── Admin Authentication (Google Sign-In Firebase ID Token Only, NO PIN) ────
async function verifyAdminBearer(bearer) {
  if (!bearer || !hasFbApps()) return null;
  try {
    const decodedFb = await fbAdmin.auth().verifyIdToken(bearer);
    if (!decodedFb || !decodedFb.email || decodedFb.email_verified === false) return null;

    const emailLower = decodedFb.email.toLowerCase();
    const envAdmins = getEnvAdminEmails();

    if (firestoreEnabled && db) {
      const whiteDoc = await db.collection("admin_whitelist").doc(emailLower).get();
      if (whiteDoc.exists || envAdmins.has(emailLower)) {
        return {
          uid: decodedFb.uid,
          email: emailLower,
          name: decodedFb.name || emailLower,
          picture: decodedFb.picture || "",
          role: "admin",
          provider: "firebase",
        };
      }
      return null;
    }

    if (envAdmins.has(emailLower)) {
      return {
        uid: decodedFb.uid,
        email: emailLower,
        name: decodedFb.name || emailLower,
        picture: decodedFb.picture || "",
        role: "admin",
        provider: "firebase",
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function requireAdmin(req, res, next) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();

  if (CFG.allowLocalDevAdmin && !bearer) {
    const rawIp = String(req.ip || req.socket?.remoteAddress || "");
    if (rawIp === "127.0.0.1" || rawIp === "::1" || rawIp === "::ffff:127.0.0.1") {
      req.adminUser = { email: "local-dev@localhost", name: "Local Dev", role: "admin", provider: "local_dev" };
      return next();
    }
  }

  if (!bearer) {
    return res.status(401).json({ error: "กรุณาเข้าสู่ระบบด้วยบัญชี Google ที่ได้รับสิทธิ์ผู้ดูแล" });
  }

  const adminUser = await verifyAdminBearer(bearer);
  if (!adminUser) {
    return res.status(403).json({ error: "สิทธิ์ไม่เพียงพอหรือ Token หมดอายุ กรุณาเข้าสู่ระบบด้วย Google ใหม่" });
  }

  req.adminUser = adminUser;
  next();
}

// ═════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/state — Public kiosk state (zero PII/secrets)
app.get("/api/state", (_, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  Object.values(state.ports).forEach((p) => {
    if (p.status === "pending_payment") expirePaymentSession(p);
  });

  const isEspOnline = !!(state.lastEsp32?.lastSeen && (Date.now() - new Date(state.lastEsp32.lastSeen).getTime() < 15000));
  const visitStats = computeVisitStats();

  res.json({
    deviceId: state.deviceId,
    ...getRuntimePublicConfig(),
    stats: {
      totalVisits: visitStats.totalVisits,
      todayVisits: visitStats.todayVisits,
      uniqueVisitors: visitStats.uniqueVisitors,
    },
    updatedAt: state.updatedAt,
    esp32: {
      isOnline: isEspOnline,
      status: isEspOnline ? "online" : "offline",
      ip: state.lastEsp32?.ip ? maskIp(state.lastEsp32.ip) : null,
      rssi: state.lastEsp32?.rssi || null,
      lastSeen: state.lastEsp32?.lastSeen || null,
    },
    ports: buildPublicPortsSnapshot(),
  });
});

// GET /api/ping & /api/health
app.get(["/api/ping", "/api/health"], (_, res) => {
  const activeCount = Object.values(state.ports).filter((p) => p.status === "in-use").length;
  const visitStats = computeVisitStats();
  res.json({
    status: "ok",
    system: "Smart USB Charger",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: now(),
    activePorts: activeCount,
    totalVisits: visitStats.totalVisits,
    uniqueVisitors: visitStats.uniqueVisitors,
    easyslip: !!CFG.easyslipKey,
    firestore: firestoreEnabled,
  });
});

// POST /api/stats/visit — Track website visitor with random VIS-XXXXXX & USR-XXXXXX IDs
app.post("/api/stats/visit", limiterVisit, (req, res) => {
  if (!state.visits) state.visits = [];

  const visitId = sanitizeTaggedId(req.body?.visitId, "VIS") || generateRandomId("VIS", state.visits.map((v) => v.id));
  const visitorId = sanitizeTaggedId(req.body?.visitorId, "USR") || generateRandomId("USR");

  // Deduplicate if client retries the same visitId on server wake-up
  const existing = state.visits.find((v) => v.id === visitId);
  if (existing) {
    const stats = computeVisitStats();
    return res.json({
      success: true,
      deduped: true,
      visitId: existing.id,
      visitorId: existing.visitorId,
      ...stats,
    });
  }

  const rawIp = req.headers["x-forwarded-for"] || req.ip || req.socket?.remoteAddress || "local";
  const visit = {
    id: visitId,
    visitorId,
    page: String(req.body?.page || "/").slice(0, 60),
    deviceType: parseDeviceType(req.body?.deviceType, req.headers["user-agent"]),
    ipMask: maskIp(String(rawIp).split(",")[0]),
    timestamp: now(),
  };

  state.visits.push(visit);
  if (state.visits.length > 3000) state.visits = state.visits.slice(-3000);

  syncVisitToFirestore(visit);
  saveState();

  const stats = computeVisitStats();
  res.json({
    success: true,
    visitId: visit.id,
    visitorId: visit.visitorId,
    ...stats,
  });
});

// ─── Payment Flows ────────────────────────────────────────────────────────────

app.post("/api/payment/hold", (req, res) => {
  const { portId, clientId, holdSessionId, visitorId } = req.body;
  const port = getPort(portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status === "in-use") {
    return res.status(409).json({ error: "พอร์ตนี้กำลังใช้งานอยู่", status: "in-use" });
  }

  expirePaymentSession(port);

  const safeVisitorId = sanitizeTaggedId(visitorId, "USR") || generateRandomId("USR");

  if (port.status === "pending_payment" && port.paymentSession) {
    const diffMs = new Date(port.paymentSession.expiresAt).getTime() - Date.now();
    if (diffMs > 0) {
      const isSameClient =
        (clientId && port.paymentSession.clientId === clientId) ||
        (holdSessionId && port.paymentSession.id === holdSessionId);
      if (isSameClient || (port.paymentSession.method === "holding" && diffMs < 5000)) {
        port.paymentSession.expiresAt = new Date(Date.now() + 45_000).toISOString();
        port.paymentSession.updatedAt = now();
        port.paymentSession.visitorId = port.paymentSession.visitorId || safeVisitorId;
        state.updatedAt = now();
        saveState();
        return res.json({ success: true, session: port.paymentSession, renewed: true });
      }

      return res.status(409).json({
        error: `ช่อง ${port.label} กำลังมีผู้ใช้งานอื่นทำรายการอยู่ (${port.paymentSession.method === "holding" ? "กำลังเลือกยอด" : "รอชำระเงิน"})`,
        status: "pending_payment",
        method: port.paymentSession.method,
        expiresInSec: Math.max(1, Math.round(diffMs / 1000)),
      });
    }
  }

  const holdSession = {
    id: generateRandomId("HOLD"),
    portId,
    clientId: clientId || null,
    visitorId: safeVisitorId,
    method: "holding",
    amount: 0,
    chargeSeconds: 0,
    createdAt: now(),
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
  };

  port.status = "pending_payment";
  port.paymentSession = holdSession;
  state.updatedAt = now();
  saveState();

  addSystemLog("SERVER", "info", `ผู้ใช้ ${safeVisitorId} เลือกช่อง ${port.label} (ล็อคช่องชั่วคราว 45 วิ)`);
  res.json({ success: true, session: holdSession });
});

app.post("/api/payment/create", limiterPaymentCreate, async (req, res) => {
  const { portId, method, visitorId } = req.body;
  const amount = Number(req.body.amount);

  if (!["qr", "transfer", "coin", "cash", "truemoney"].includes(method)) {
    return res.status(400).json({ error: "วิธีชำระไม่ถูกต้อง (qr | transfer | coin | cash | truemoney)" });
  }
  const normMethod = method === "cash" ? "coin" : method;
  if (!Number.isFinite(amount) || amount < 1) {
    return res.status(400).json({ error: "จำนวนเงินต้องไม่น้อยกว่า 1 บาท" });
  }
  if (amount > 100) {
    return res.status(400).json({ error: "จำนวนเงินต้องไม่เกิน 100 บาท" });
  }
  if (normMethod === "coin" && (amount < 5 || amount % 5 !== 0)) {
    return res.status(400).json({ error: "รับชำระด้วยเหรียญเฉพาะยอด 5 บาทขึ้นไป และเป็นทวีคูณของ 5 บาท" });
  }
  if (normMethod === "truemoney" && amount < 10) {
    return res.status(400).json({ error: "TrueMoney ขั้นต่ำ 10 บาทขึ้นไป" });
  }

  const port = getPort(portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status === "in-use") {
    return res.status(409).json({ error: "พอร์ตนี้กำลังใช้งานอยู่", status: port.status });
  }

  expirePaymentSession(port);

  if (port.status === "pending_payment" && port.paymentSession) {
    const holdId = req.body.holdSessionId;
    const clientId = req.body.clientId;
    const isOwner =
      (holdId && port.paymentSession.id === holdId) ||
      (clientId && port.paymentSession.clientId === clientId) ||
      port.paymentSession.method === "holding";
    if (!isOwner) {
      return res.status(409).json({ error: "พอร์ตนี้มีผู้ใช้งานอื่นกำลังทำรายการชำระเงินอยู่", status: port.status });
    }
  }

  const safeVisitorId = sanitizeTaggedId(visitorId, "USR") || port.paymentSession?.visitorId || generateRandomId("USR");
  const rounded = Math.round(amount * 100) / 100;
  const chargeSeconds = Math.round(rounded * CFG.secondsPerBaht);
  const expiresAt = new Date(Date.now() + CFG.sessionExpireMs).toISOString();

  const session = {
    id: generateRandomId("PAY"),
    portId,
    amount: rounded,
    method: normMethod,
    chargeSeconds,
    clientId: req.body.clientId || null,
    visitorId: safeVisitorId,
    createdAt: now(),
    expiresAt,
  };

  if (normMethod === "qr") {
    if (!CFG.promptpayPhone) {
      return res.status(503).json({ error: "ระบบยังไม่ได้ตั้งค่าหมายเลข PromptPay (ติดต่อผู้ดูแลตั้งค่าในหน้า Admin หรือ ENV)" });
    }
    try {
      const payload = generatePayload(CFG.promptpayPhone, { amount: rounded });
      const qrImage = await QRCode.toDataURL(payload, { width: 320, margin: 2, color: { dark: "#111827", light: "#fff" } });
      session.qr = { payload, image: qrImage, phone: maskPhoneForDisplay(CFG.promptpayPhone), accountName: CFG.bankAccountName || "เจ้าของตู้ชาร์จ" };
    } catch (err) {
      return res.status(500).json({ error: `สร้าง QR ไม่สำเร็จ: ${err.message}` });
    }
  } else if (normMethod === "transfer") {
    if (!CFG.bankAccount && !CFG.promptpayPhone) {
      return res.status(503).json({ error: "ระบบยังไม่ได้ตั้งค่าบัญชีธนาคารรับโอน (ติดต่อผู้ดูแล)" });
    }
    session.bank = {
      name: CFG.bankName || "ธนาคาร",
      account: CFG.bankAccount,
      accountName: CFG.bankAccountName || "เจ้าของตู้ชาร์จ",
      phone: CFG.promptpayPhone,
    };
  } else if (normMethod === "truemoney") {
    if (!CFG.truemoneyPhone && !CFG.promptpayPhone) {
      return res.status(503).json({ error: "ระบบยังไม่ได้ตั้งค่าหมายเลขรับโอน TrueMoney (ติดต่อผู้ดูแล)" });
    }
    session.truemoney = {
      phone: CFG.truemoneyPhone || CFG.promptpayPhone,
      accountName: CFG.bankAccountName || "เจ้าของตู้ชาร์จ",
    };
  }

  port.status = "pending_payment";
  port.paymentSession = session;
  state.updatedAt = now();
  saveState();

  addSystemLog("SERVER", "info", `ผู้ใช้ ${safeVisitorId} สร้างรายการ ${normMethod.toUpperCase()} พอร์ต ${port.label} ยอด ${rounded} บาท [${session.id}]`);
  res.json({ success: true, session });
});

function queueManualApproval({ port, session, amount, method, visitorId, reason, senderLabel, imageBuffer, mimetype, slipHash }) {
  const pendingId = generateRandomId("PEN", state.pendingApprovals.map((p) => p.id));
  const safeVisitorId = sanitizeTaggedId(visitorId, "USR") || session?.visitorId || generateRandomId("USR");
  const base64Thumb = imageBuffer && mimetype && imageBuffer.length <= 1.2 * 1024 * 1024
    ? `data:${mimetype};base64,${imageBuffer.toString("base64")}`
    : null;

  const pendingItem = {
    id: pendingId,
    portId: port.id,
    portLabel: port.label,
    portType: port.type,
    amount,
    method,
    visitorId: safeVisitorId,
    payerName: senderLabel || defaultPayerLabel(method),
    receiverName: CFG.bankAccountName || "เจ้าของตู้ชาร์จ",
    receiverAccount: defaultReceiverChannel(method),
    reason: reason || "MANUAL_REVIEW_REQUIRED",
    status: "pending",
    createdAt: now(),
    imageDataUrl: base64Thumb,
    slipHash: slipHash || null,
  };

  state.pendingApprovals.unshift(pendingItem);
  if (state.pendingApprovals.length > 50) state.pendingApprovals.pop();
  syncPendingToFirestore(pendingItem);
  saveState();

  addSystemLog("SLIP", "warn", `ส่งคำขอรอแอดมินตรวจ [${pendingId}] พอร์ต ${port.label} ยอด ${amount} บาท (${safeVisitorId})`);
  return pendingItem;
}

const inFlightSlipHashes = new Set();
const inFlightPortVerifications = new Set();

app.post("/api/payment/verify-slip", limiterVerifySlip, upload.single("image"), async (req, res) => {
  const port = getPort(req.body.portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (expirePaymentSession(port)) return res.status(410).json({ error: "หมดเวลาชำระเงิน กรุณาเริ่มรายการใหม่" });
  if (port.status !== "pending_payment" || !port.paymentSession) {
    return res.status(400).json({ error: "ไม่มีรายการรอชำระเงินสำหรับพอร์ตนี้" });
  }
  if (!["qr", "transfer", "truemoney"].includes(port.paymentSession.method)) {
    return res.status(400).json({ error: "วิธีชำระนี้ไม่ใช้สลิป" });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: "กรุณาอัปโหลดรูปสลิป" });
  }

  const slipHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

  // In-flight and duplicate check to prevent race conditions
  if (state.usedSlipHashes && state.usedSlipHashes.has(slipHash)) {
    return res.status(422).json({ success: false, reason: "DUPLICATE_SLIP", message: "สลิปนี้ถูกใช้งานในระบบไปแล้ว" });
  }
  if (inFlightSlipHashes.has(slipHash) || inFlightPortVerifications.has(port.id)) {
    return res.status(409).json({ success: false, reason: "IN_FLIGHT", message: "กำลังตรวจสอบสลิปนี้หรือพอร์ตนี้อยู่ กรุณารอสักครู่" });
  }

  inFlightSlipHashes.add(slipHash);
  inFlightPortVerifications.add(port.id);

  try {
    const session = port.paymentSession;
    const visitorId = sanitizeTaggedId(req.body.visitorId, "USR") || session.visitorId;
    const result = await verifySlip(req.file.buffer, req.file.mimetype, session.amount);

    if (!result.valid) {
      // TrueMoney direct transfers without BOT QR or EasySlip outage -> queue for Admin manual approval (NO unverified auto-activate!)
      if (result.needsManualReview || (session.method === "truemoney" && result.reason === "SLIP_NOT_FOUND")) {
        const pending = queueManualApproval({
          port,
          session,
          amount: session.amount,
          method: session.method,
          visitorId,
          reason: result.reason,
          senderLabel: session.method === "truemoney" ? "ผู้โอน TrueMoney (รออนุมัติสลิป)" : "ผู้โอนสลิป (รอตรวจมือ)",
          imageBuffer: req.file.buffer,
          mimetype: req.file.mimetype,
          slipHash,
        });

        return res.status(202).json({
          success: false,
          pendingApproval: true,
          pendingId: pending.id,
          reason: result.reason,
          message: `ส่งสลิปเข้าคิวรอผู้ดูแลอนุมัติแล้ว (รหัสอ้างอิง ${pending.id}) กรุณารอผู้ดูแลตรวจสอบสักครู่หรือแจ้งผ่านแชต`,
        });
      }

      console.log(`[SLIP] Verification failed port=${port.id} reason=${result.reason}`);
      return res.status(422).json({ success: false, reason: result.reason, message: result.message });
    }

    const tx = activatePort(port.id, session.amount, session.method, {
      visitorId,
      transRef: result.transRef,
      slipHash,
      sender: result.sender,
      senderBank: result.senderBank,
      receiver: result.receiver,
      receiverAccount: result.receiverAccount,
      receiverBank: result.receiverBank,
      slipDate: result.slipDate,
      isDev: !!result.isDev,
    });

    if (!tx) {
      // Atomic guard: If port was unexpectedly occupied while awaiting slip, queue for admin so money is never lost!
      const pending = queueManualApproval({
        port,
        session,
        amount: session.amount,
        method: session.method,
        visitorId,
        reason: "PORT_OCCUPIED_CONCURRENTLY",
        senderLabel: result.sender || "ผู้โอนผ่านสลิป",
        imageBuffer: req.file.buffer,
        mimetype: req.file.mimetype,
        slipHash,
      });

      return res.status(202).json({
        success: false,
        pendingApproval: true,
        pendingId: pending.id,
        reason: "PORT_CONFLICT",
        message: `ยอดเงินถูกต้อง แต่พอร์ตถูกเปิดใช้งานซ้อน ระบบส่งเข้าคิวรอผู้ดูแลจัดสรรพอร์ตให้ทันที (รหัส ${pending.id})`,
      });
    }

    addSystemLog("SLIP", "success", `ตรวจสลิปผ่าน [${tx.id}] ${tx.payerId} (${tx.payerName}) -> ${tx.receiverAccount} | ${port.label} (${session.amount} บาท)`);
    res.json({ success: true, transaction: tx, sender: tx.payerName, isDev: !!result.isDev });
  } finally {
    inFlightSlipHashes.delete(slipHash);
    inFlightPortVerifications.delete(port.id);
  }
});

app.post("/api/payment/truemoney-voucher", limiterPaymentCreate, (req, res) => {
  const { portId, amount, voucherUrl, visitorId } = req.body;
  const port = getPort(portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status === "in-use") return res.status(409).json({ error: "พอร์ตนี้กำลังใช้งานอยู่" });

  if (!voucherUrl || typeof voucherUrl !== "string") {
    return res.status(400).json({ error: "กรุณาระบุลิงก์ซองของขวัญ TrueMoney" });
  }

  const expectedAmount = Number(amount);
  if (!Number.isFinite(expectedAmount) || expectedAmount < 10 || expectedAmount > 100) {
    return res.status(400).json({ error: "TrueMoney ซองของขวัญต้องมียอด 10 - 100 บาท" });
  }

  const targetMobile = String(CFG.truemoneyPhone || CFG.promptpayPhone || "").replace(/\D/g, "");
  if (!/^0\d{8,9}$/.test(targetMobile)) {
    return res.status(503).json({ error: "ระบบยังไม่ได้ตั้งค่าเบอร์รับซองของขวัญ TrueMoney" });
  }

  const hashMatch = (voucherUrl.split("v=")[1] || voucherUrl).match(/[0-9A-Za-z]{35}/);
  if (!hashMatch) {
    return res.status(400).json({ error: "ลิงก์ซองของขวัญไม่ถูกต้อง (ต้องเป็นลิงก์ gift.truemoney.com)" });
  }
  const hash = hashMatch[0];
  if (!/^[0-9A-Za-z]{35}$/.test(hash)) {
    return res.status(400).json({ error: "รหัสซองของขวัญไม่ถูกต้อง" });
  }

  const safeVisitorId = sanitizeTaggedId(visitorId, "USR") || port.paymentSession?.visitorId || generateRandomId("USR");
  const curlBin = process.platform === "win32" ? "curl.exe" : "curl";
  const payload = JSON.stringify({ mobile: targetMobile, voucher_hash: hash });

  try {
    execFile(
      curlBin,
      [
        "-s",
        "-X", "POST",
        `https://gift.truemoney.com/campaign/vouchers/${hash}/redeem`,
        "-H", "Content-Type: application/json",
        "-H", "User-Agent: Mozilla/5.0",
        "-d", payload,
      ],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) {
          return res.status(502).json({ error: `เชื่อมต่อ TrueMoney ไม่สำเร็จ: ${err.message}` });
        }

        let data;
        try {
          data = JSON.parse(stdout);
        } catch (_) {
          return res.status(502).json({ error: "TrueMoney ตอบกลับข้อมูลไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง" });
        }

        if (data?.status?.code === "SUCCESS" || data?.status?.message === "success") {
          const redeemedAmt = parseFloat(data.data?.my_ticket?.amount_baht || data.data?.voucher?.redeemed_amount_baht || 0);
          if (redeemedAmt < expectedAmount) {
            return res.status(422).json({
              error: `ยอดเงินในซองของขวัญไม่เพียงพอ (ต้องการ ${expectedAmount} บาท แต่ในซองมี ${redeemedAmt} บาท)`,
            });
          }

          const senderName = data.data?.owner_profile?.full_name || "ผู้ส่งซอง TrueMoney";
          const tx = activatePort(port.id, redeemedAmt, "truemoney_voucher", {
            visitorId: safeVisitorId,
            sender: senderName,
            senderBank: "TrueMoney Voucher",
            receiver: CFG.bankAccountName || "เจ้าของตู้ชาร์จ",
            receiverAccount: `TrueMoney (${maskPhoneForDisplay(targetMobile)})`,
            receiverBank: "TrueMoney Wallet",
            voucherHash: hash,
            transRef: `TMN-${hash.slice(0, 10)}`,
          });

          addSystemLog("TMN", "success", `รับซองของขวัญ TrueMoney [${tx.id}] ${tx.payerId} (${senderName}) ${redeemedAmt} บาท -> ${port.label}`);
          return res.json({
            success: true,
            transaction: tx,
            sender: senderName,
            amount: redeemedAmt,
            chargeSeconds: tx.chargeSeconds,
          });
        }

        const code = data?.status?.code;
        let errMsg = "รับซองของขวัญไม่สำเร็จ";
        if (code === "VOUCHER_OUT_OF_STOCK") errMsg = "ซองของขวัญนี้ถูกรับไปแล้ว หรือหมดอายุ";
        else if (code === "VOUCHER_NOT_FOUND") errMsg = "ไม่พบซองของขวัญนี้ กรุณาตรวจสอบลิงก์อีกครั้ง";
        else if (code === "CANNOT_GET_OWN_VOUCHER") errMsg = "ไม่สามารถรับซองของขวัญของตนเองได้";
        else if (code === "TARGET_USER_REDEEMED") errMsg = "ซองนี้ถูกรับไปแล้ว";
        else if (data?.status?.message) errMsg = `TrueMoney: ${data.status.message}`;

        return res.status(400).json({ error: errMsg, code });
      }
    );
  } catch (e) {
    return res.status(500).json({ error: `เกิดข้อผิดพลาดในการประมวลผล: ${e.message}` });
  }
});

app.post("/api/coin/insert", requireEsp32Auth, limiterCoin, (req, res) => {
  const port = getPort(req.body.portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (expirePaymentSession(port)) return res.status(410).json({ error: "หมดเวลาชำระเงิน กรุณาเริ่มรายการใหม่" });
  if (port.status !== "pending_payment" || !["coin", "cash"].includes(port.paymentSession?.method)) {
    return res.status(409).json({ error: "พอร์ตนี้ไม่ได้รอการหยอดเหรียญ" });
  }

  const amount = Number(req.body.amount || 0);
  if (!Number.isFinite(amount) || amount % 5 !== 0 || amount < port.paymentSession.amount) {
    return res.status(422).json({
      success: false,
      reason: "AMOUNT_TOO_LOW",
      message: `ยอดเหรียญ ${amount} บาทไม่พอหรือไม่ถูกต้อง (ต้องการ ${port.paymentSession.amount} บาท)`,
    });
  }

  const tx = activatePort(port.id, port.paymentSession.amount, "coin", {
    visitorId: port.paymentSession.visitorId,
    sender: "ผู้หยอดเหรียญหน้าตู้",
    senderBank: "Coin Acceptor",
    receiver: CFG.bankAccountName || "ตู้ชาร์จ (กล่องเหรียญ)",
    receiverAccount: "กล่องรับเหรียญ 5/10 บาท",
    receiverBank: "Cash",
    coinsInserted: amount,
    transRef: generateRandomId("COIN"),
  });
  res.json({ success: true, transaction: tx, coinsInserted: amount });
});

app.post("/api/payment/cancel", (req, res) => {
  const { portId, sessionId, clientId } = req.body;
  const port = getPort(portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (!port.paymentSession) {
    if (port.status === "pending_payment") clearSession(port.id);
    return res.json({ success: true, message: "ไม่มีรายการค้างอยู่" });
  }

  const isHolding = port.paymentSession.method === "holding";
  const isMatchingSession = !sessionId || port.paymentSession.id === sessionId;
  const isMatchingClient = clientId && port.paymentSession.clientId === clientId;

  if (isHolding || isMatchingSession || isMatchingClient) {
    clearSession(port.id);
    addSystemLog("SERVER", "info", `ยกเลิกรายการพอร์ต ${port.label} (คืนสถานะว่างทันที)`);
    return res.json({ success: true, released: true });
  }

  return res.status(403).json({ error: "ไม่อนุญาต: รหัส session ไม่ตรงกัน" });
});

// ─── Admin Routes (Strict Google Auth + Audit Logs, Zero PIN) ─────────────────

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ success: true, admin: req.adminUser });
});

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  const isEspOnline = !!(state.lastEsp32?.lastSeen && (Date.now() - new Date(state.lastEsp32.lastSeen).getTime() < 15000));
  res.json({
    admin: req.adminUser,
    summary: summary(),
    ports: Object.values(state.ports),
    transactions: state.transactions.slice(0, 200),
    visits: (state.visits || []).slice(-300),
    auditLogs: (state.auditLogs || []).slice(0, 100),
    pendingApprovals: (state.pendingApprovals || []).filter((p) => p.status === "pending"),
    config: getRuntimeAdminConfig(),
    lastEsp32: state.lastEsp32,
    esp32: {
      ...(state.lastEsp32 || {}),
      isOnline: isEspOnline,
      status: isEspOnline ? "online" : "offline",
    },
    esp32Control: sanitizeEsp32ControlForAdmin(),
    logs: (state.systemLogs || []).slice(0, 60),
    updatedAt: state.updatedAt,
  });
});

app.get("/api/admin/audit-logs", requireAdmin, (_, res) => {
  res.json({ auditLogs: state.auditLogs || [] });
});

app.get("/api/admin/pending-payments", requireAdmin, (_, res) => {
  res.json({
    pendingApprovals: (state.pendingApprovals || []).filter((p) => p.status === "pending"),
  });
});

app.post("/api/admin/pending-payments/:id/approve", requireAdmin, (req, res) => {
  const pending = state.pendingApprovals.find((p) => p.id === req.params.id);
  if (!pending) return res.status(404).json({ error: "ไม่พบคำขอรออนุมัตินี้" });
  if (pending.status !== "pending") return res.status(409).json({ error: "คำขอนี้ถูกดำเนินการไปแล้ว" });

  const port = getPort(pending.portId);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status === "in-use") {
    return res.status(409).json({ error: `พอร์ต ${port.label} กำลังชาร์จอยู่ ไม่สามารถเปิดซ้อนได้` });
  }

  pending.status = "approved";
  pending.resolvedAt = now();
  pending.resolvedBy = req.adminUser.email;
  if (pending.slipHash) {
    state.usedSlipHashes.add(pending.slipHash);
  }
  delete pending.imageDataUrl; // discard temporary slip image after review

  const tx = activatePort(port.id, pending.amount, pending.method, {
    visitorId: pending.visitorId,
    sender: pending.payerName,
    senderBank: pending.method === "truemoney" ? "TrueMoney (อนุมัติโดยผู้ดูแล)" : "Slip (อนุมัติโดยผู้ดูแล)",
    receiver: pending.receiverName,
    receiverAccount: pending.receiverAccount,
    receiverBank: CFG.bankName || "บัญชีตู้ชาร์จ",
    transRef: pending.id,
    approvedBy: req.adminUser.email,
  });

  pending.txId = tx?.id || null;
  syncPendingToFirestore(pending);
  addAuditLog(req.adminUser, "APPROVE_PAYMENT", port.id, { pendingId: pending.id, txId: tx.id, amount: pending.amount });
  res.json({ success: true, transaction: tx, pending });
});

app.post("/api/admin/pending-payments/:id/reject", requireAdmin, (req, res) => {
  const pending = state.pendingApprovals.find((p) => p.id === req.params.id);
  if (!pending) return res.status(404).json({ error: "ไม่พบคำขอรออนุมัตินี้" });
  if (pending.status !== "pending") return res.status(409).json({ error: "คำขอนี้ถูกดำเนินการไปแล้ว" });

  pending.status = "rejected";
  pending.resolvedAt = now();
  pending.resolvedBy = req.adminUser.email;
  pending.rejectReason = String(req.body?.reason || "ไม่พบยอดโอนเข้าบัญชี").slice(0, 200);
  delete pending.imageDataUrl;

  const port = getPort(pending.portId);
  if (port && port.status === "pending_payment") {
    clearSession(port.id);
  }

  syncPendingToFirestore(pending);
  addAuditLog(req.adminUser, "REJECT_PAYMENT", pending.portId, { pendingId: pending.id, reason: pending.rejectReason });
  res.json({ success: true, pending });
});

// ── Public Endpoint: Check Pending Slip Approval Status Real-time ──
app.get("/api/payment/pending/:id", (req, res) => {
  const pendingId = req.params.id;
  const pending = (state.pendingApprovals || []).find((p) => p.id === pendingId);
  if (!pending) {
    return res.status(404).json({ success: false, error: "ไม่พบคำขอตรวจสอบสลิปนี้" });
  }
  res.json({
    success: true,
    pending: {
      id: pending.id,
      status: pending.status, // "pending" | "approved" | "rejected"
      portId: pending.portId,
      portLabel: pending.portLabel,
      amount: pending.amount,
      method: pending.method,
      rejectReason: pending.rejectReason || null,
      resolvedAt: pending.resolvedAt || null,
      resolvedBy: pending.resolvedBy ? "ผู้ดูแลระบบ" : null,
      txId: pending.txId || null,
      createdAt: pending.createdAt,
    },
  });
});

// ── Customer / Kiosk Endpoint: Early Stop Charging ──
app.post("/api/payment/early-stop", (req, res) => {
  const { portId, visitorId, txId } = req.body || {};
  const port = getPort(portId);
  if (!port) return res.status(404).json({ success: false, error: "ไม่พบพอร์ตนี้" });
  if (port.status !== "in-use") {
    return res.status(409).json({ success: false, error: "พอร์ตนี้ไม่ได้กำลังชาร์จอยู่" });
  }

  // Security check: Match visitorId or transaction ID
  const curTx = port.currentTx;
  const isAuthorized = !curTx || !curTx.visitorId || curTx.visitorId === visitorId || curTx.id === txId;
  if (!isAuthorized) {
    return res.status(403).json({ success: false, error: "คุณไม่มีสิทธิ์หยุดการชาร์จของพอร์ตนี้" });
  }

  const stoppedSeconds = port.remainingSeconds;
  const ok = stopPort(port.id, "early_stop");
  addSystemLog("KIOSK", "info", `ผู้ใช้กดหยุดชาร์จพอร์ต ${port.label} ก่อนเวลา (เวลาที่เหลือ ${stoppedSeconds}s ถูกตัด)`);
  res.json({
    success: ok,
    message: `หยุดชาร์จพอร์ต ${port.label} ก่อนเวลาเรียบร้อยแล้ว`,
    port: getPort(port.id),
  });
});

app.post("/api/admin/config", requireAdmin, (req, res) => {
  const {
    promptpayPhone,
    truemoneyPhone,
    bankName,
    bankAccount,
    bankAccountName,
    secondsPerBaht,
    easyslipKey,
    supportPhone,
    supportLine,
    supportIg,
    supportLocation,
  } = req.body;

  if (promptpayPhone !== undefined) CFG.promptpayPhone = String(promptpayPhone).trim().slice(0, 30);
  if (truemoneyPhone !== undefined) CFG.truemoneyPhone = String(truemoneyPhone).trim().slice(0, 30);
  if (bankName !== undefined) CFG.bankName = String(bankName).trim().slice(0, 80);
  if (bankAccount !== undefined) CFG.bankAccount = String(bankAccount).trim().slice(0, 40);
  if (bankAccountName !== undefined) CFG.bankAccountName = String(bankAccountName).trim().slice(0, 120);
  if (secondsPerBaht !== undefined) {
    const rate = Number(secondsPerBaht);
    if (!Number.isFinite(rate) || rate < 10 || rate > 3600) {
      return res.status(400).json({ error: "อัตราค่าชาร์จ (วินาที/บาท) ต้องอยู่ระหว่าง 10 ถึง 3600" });
    }
    CFG.secondsPerBaht = Math.round(rate);
  }
  if (easyslipKey !== undefined && String(easyslipKey).trim()) CFG.easyslipKey = String(easyslipKey).trim();
  if (supportPhone !== undefined) CFG.supportPhone = String(supportPhone).trim().slice(0, 30);
  if (supportLine !== undefined) CFG.supportLine = String(supportLine).trim().slice(0, 60);
  if (supportIg !== undefined) CFG.supportIg = String(supportIg).trim().slice(0, 60);
  if (supportLocation !== undefined) CFG.supportLocation = String(supportLocation).trim().slice(0, 120);

  state.updatedAt = now();
  addAuditLog(req.adminUser, "UPDATE_CONFIG", "system", { secondsPerBaht: CFG.secondsPerBaht, supportLocation: CFG.supportLocation });
  saveState();

  res.json({
    success: true,
    message: "บันทึกการตั้งค่าระบบเรียบร้อย",
    config: getRuntimeAdminConfig(),
  });
});

app.post("/api/admin/port/:id/stop", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  const ok = stopPort(req.params.id, "admin_stop");
  addAuditLog(req.adminUser, "STOP_PORT", req.params.id, { ok });
  res.json({ success: ok, port: getPort(req.params.id) });
});

app.post("/api/admin/port/:id/clear", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  clearSession(req.params.id);
  addAuditLog(req.adminUser, "CLEAR_SESSION", req.params.id);
  res.json({ success: true, port: getPort(req.params.id) });
});

app.post("/api/admin/port/:id/pause", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port || port.status !== "in-use") return res.status(400).json({ error: "พอร์ตไม่ได้อยู่ในสถานะชาร์จ" });
  port.isPaused = true;
  port.relayOn = false;
  state.updatedAt = now();
  saveState();
  addSystemLog("RELAY", "warn", `พักชาร์จชั่วคราว ${port.label} -> ตัดไฟรีเลย์`);
  addAuditLog(req.adminUser, "PAUSE_PORT", port.id, { remainingSeconds: port.remainingSeconds });
  res.json({ success: true, isPaused: true, remainingSeconds: port.remainingSeconds, port });
});

app.post("/api/admin/port/:id/resume", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port || port.status !== "in-use") return res.status(400).json({ error: "พอร์ตไม่ได้อยู่ในสถานะชาร์จ" });
  port.isPaused = false;
  port.relayOn = true;
  state.updatedAt = now();
  saveState();
  addSystemLog("RELAY", "success", `ชาร์จต่อ ${port.label} -> เปิดไฟรีเลย์`);
  addAuditLog(req.adminUser, "RESUME_PORT", port.id, { remainingSeconds: port.remainingSeconds });
  res.json({ success: true, isPaused: false, remainingSeconds: port.remainingSeconds, port });
});

app.post("/api/admin/port/:id/test-start", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  if (port.status === "in-use") stopPort(port.id, "restart_test");

  const durationSeconds = Math.min(3600, Math.max(5, Number(req.body.durationSeconds) || 30));
  const amount = Math.max(0, Number(req.body.amount) || 0);

  const tx = activatePort(port.id, amount, "test", {
    isTest: true,
    testDuration: durationSeconds,
    sender: `ทดสอบโดย ${req.adminUser.email}`,
    senderBank: "Admin Panel",
    receiver: port.label,
    receiverAccount: `GPIO ${port.relayGpio}`,
    transRef: generateRandomId("TST"),
  });

  addAuditLog(req.adminUser, "TEST_START", port.id, { durationSeconds, txId: tx.id });
  res.json({ success: true, transaction: tx, durationSeconds, port: state.ports[port.id] });
});

app.post("/api/admin/port/:id/set-time", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port || port.status !== "in-use") return res.status(400).json({ error: "พอร์ตไม่ได้อยู่ในสถานะชาร์จ" });
  const seconds = Math.min(86400, Math.max(1, Number(req.body.seconds) || 5));
  port.remainingSeconds = seconds;
  state.updatedAt = now();
  saveState();
  addAuditLog(req.adminUser, "SET_TIME", port.id, { seconds });
  res.json({ success: true, remainingSeconds: port.remainingSeconds, port });
});

app.all("/api/admin/port/:id/toggle-relay", requireAdmin, (req, res) => {
  const port = getPort(req.params.id);
  if (!port) return res.status(404).json({ error: "ไม่พบพอร์ตนี้" });
  let turnOn = !port.relayOn;
  if (typeof req.body?.on === "boolean") turnOn = req.body.on;
  if (typeof req.query?.on !== "undefined") turnOn = req.query.on === "true" || req.query.on === "1";

  port.relayOn = turnOn;
  state.updatedAt = now();
  addSystemLog("RELAY", "info", `สวิตช์รีเลย์ ${port.label} (GPIO ${port.relayGpio}) -> ${turnOn ? "เปิดไฟ (ON)" : "ตัดไฟ (OFF)"}`);
  addAuditLog(req.adminUser, "TOGGLE_RELAY", port.id, { relayOn: turnOn, gpio: port.relayGpio });
  saveState();
  res.json({ success: true, portId: port.id, relayGpio: port.relayGpio, relayOn: port.relayOn });
});

app.post("/api/admin/reset", requireAdmin, (req, res) => {
  Object.values(state.ports).forEach((p) => {
    p.status = "available";
    p.relayOn = false;
    p.isPaused = false;
    p.paymentSession = null;
    p.currentTx = null;
    p.remainingSeconds = 0;
    p.totalSeconds = 0;
  });
  state.updatedAt = now();
  addAuditLog(req.adminUser, "RESET_ALL_PORTS", "all");
  saveState();
  res.json({ success: true });
});

app.get("/api/admin/logs", requireAdmin, (_, res) => {
  const isOnline = !!(state.lastEsp32?.lastSeen && (Date.now() - new Date(state.lastEsp32.lastSeen).getTime() < 15000));
  res.json({
    esp32: {
      ...(state.lastEsp32 || {}),
      isOnline,
      status: isOnline ? "online" : "offline",
    },
    esp32Control: sanitizeEsp32ControlForAdmin(),
    logs: state.systemLogs || [],
    auditLogs: (state.auditLogs || []).slice(0, 100),
  });
});

app.post("/api/admin/logs/clear", requireAdmin, (req, res) => {
  state.systemLogs = [];
  addSystemLog("ADMIN", "info", "ล้างบันทึกการทำงานเรียบร้อย");
  addAuditLog(req.adminUser, "CLEAR_SYSTEM_LOGS", "system");
  res.json({ success: true });
});

app.post("/api/admin/esp32/set-ip", requireAdmin, (req, res) => {
  const ip = String(req.body?.ip || "").trim().slice(0, 64);
  if (ip) {
    if (!state.lastEsp32) state.lastEsp32 = {};
    state.lastEsp32.ip = ip;
    state.lastEsp32.configuredIp = ip;
    addSystemLog("ADMIN", "info", `กำหนด IP ของบอร์ด ESP32 เป็น ${ip}`);
    addAuditLog(req.adminUser, "SET_ESP32_IP", "esp32", { ip });
    saveState();
  }
  res.json({ success: true, esp32: state.lastEsp32 });
});

app.get("/api/admin/esp32/control", requireAdmin, (_, res) => {
  const isOnline = !!(state.lastEsp32?.lastSeen && (Date.now() - new Date(state.lastEsp32.lastSeen).getTime() < 15000));
  res.json({
    success: true,
    esp32: { ...(state.lastEsp32 || {}), isOnline, status: isOnline ? "online" : "offline" },
    esp32Control: sanitizeEsp32ControlForAdmin(),
    allowedGpios: ALLOWED_RELAY_GPIOS,
  });
});

app.post("/api/admin/esp32/remote-config", requireAdmin, (req, res) => {
  const rc = state.esp32Control.remoteConfig;
  const pollInput = req.body?.pollIntervalMs;
  let nextPollMs = rc.pollIntervalMs;
  if (pollInput !== undefined) {
    const num = Number(pollInput);
    if (!Number.isInteger(num) || num < 1000 || num > 10000) {
      return res.status(400).json({ error: "Poll interval ต้องเป็นจำนวนเต็มระหว่าง 1000 ถึง 10000 ms" });
    }
    nextPollMs = num;
  }

  let nextGpioMap = rc.portGpioMap;
  if (req.body?.portGpioMap !== undefined) {
    const check = validatePortGpioMap(req.body.portGpioMap);
    if (!check.valid) return res.status(400).json({ error: check.error });

    const changed = PORT_DEFS.some((d) => check.map[d.id] !== rc.portGpioMap[d.id]);
    if (changed) {
      const activePort = findActiveChargingPort();
      if (activePort) {
        return res.status(409).json({
          error: `ไม่สามารถเปลี่ยนพิน GPIO ขณะที่พอร์ต ${activePort.label} กำลังใช้งาน/จ่ายไฟอยู่`,
        });
      }
      nextGpioMap = check.map;
      applyPortGpioMap(nextGpioMap);
    }
  }

  rc.pollIntervalMs = nextPollMs;
  rc.portGpioMap = nextGpioMap;
  rc.configVersion = (Number(rc.configVersion) || 1) + 1;
  rc.updatedAt = now();
  rc.updatedBy = req.adminUser.email;

  state.updatedAt = now();
  addSystemLog("ADMIN", "info", `อัปเดต Remote Config ESP32 (v${rc.configVersion}, poll=${rc.pollIntervalMs}ms)`);
  addAuditLog(req.adminUser, "ESP32_REMOTE_CONFIG", "esp32", {
    configVersion: rc.configVersion,
    pollIntervalMs: rc.pollIntervalMs,
    portGpioMap: rc.portGpioMap,
  });
  saveState();

  res.json({ success: true, esp32Control: sanitizeEsp32ControlForAdmin() });
});

app.post("/api/admin/esp32/command", requireAdmin, (req, res) => {
  const action = String(req.body?.action || "").trim().toLowerCase();
  if (!["restart", "hotspot"].includes(action)) {
    return res.status(400).json({ error: "คำสั่งไม่ถูกต้อง (รองรับเฉพาะ restart หรือ hotspot)" });
  }

  const activePort = findActiveChargingPort();
  if (activePort) {
    return res.status(409).json({
      error: `ไม่อนุญาตให้สั่ง ${action} ขณะพอร์ต ${activePort.label} กำลังชาร์จหรือรอชำระเงิน (ต้องปิดรีเลย์ครบทุกช่องก่อน)`,
    });
  }

  const cmdId = generateRandomId("CMD");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  state.esp32Control.pendingCommand = {
    cmdId,
    action,
    requestedAt: now(),
    requestedBy: req.adminUser.email,
    expiresAt,
  };

  addSystemLog("ADMIN", "warn", `ส่งคำสั่ง ${action.toUpperCase()} ไปยัง ESP32 (${cmdId})`);
  addAuditLog(req.adminUser, action === "restart" ? "ESP32_RESTART" : "ESP32_HOTSPOT", "esp32", { cmdId, action });

  res.json({ success: true, esp32Control: sanitizeEsp32ControlForAdmin() });
});

app.post("/api/admin/esp32/wifi", requireAdmin, (req, res) => {
  const ssid = String(req.body?.ssid || "").trim();
  const password = String(req.body?.password || "");

  if (!ssid || ssid.length > 32) {
    return res.status(400).json({ error: "ชื่อ Wi-Fi (SSID) ต้องมีความยาว 1–32 ตัวอักษร" });
  }
  if (password.length > 0 && (password.length < 8 || password.length > 63)) {
    return res.status(400).json({ error: "รหัสผ่าน Wi-Fi ต้องว่าง (Open) หรือยาว 8–63 ตัวอักษร" });
  }

  const activePort = findActiveChargingPort();
  if (activePort) {
    return res.status(409).json({
      error: `ไม่อนุญาตให้เปลี่ยน Wi-Fi ระยะไกลขณะพอร์ต ${activePort.label} กำลังชาร์จหรือรอชำระเงิน`,
    });
  }

  const wifiCmdId = generateRandomId("WIF");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  // Kept in memory only; password is never logged to audit logs or written to disk/Firestore
  state.esp32Control.pendingWifi = {
    wifiCmdId,
    ssid,
    password,
    timeoutSec: 60,
    requestedAt: now(),
    requestedBy: req.adminUser.email,
    expiresAt,
  };

  addSystemLog("ADMIN", "warn", `สั่งเปลี่ยน Wi-Fi ระยะไกลเป็น "${ssid}" (Rollback อัตโนมัติใน 60 วิ)`);
  addAuditLog(req.adminUser, "ESP32_WIFI_CHANGE", "esp32", { wifiCmdId, ssid, timeoutSec: 60 });

  res.json({ success: true, esp32Control: sanitizeEsp32ControlForAdmin() });
});

app.post("/api/admin/esp32/ota", requireAdmin, (req, res) => {
  const version = String(req.body?.version || "").trim();
  const firmwareUrlRaw = String(req.body?.firmwareUrl || "").trim();
  const sha256Raw = String(req.body?.sha256 || "").trim().toLowerCase();
  const notes = String(req.body?.notes || "").trim().slice(0, 200);
  const force = !!req.body?.force;

  if (!version || version.length > 32 || !/^[a-zA-Z0-9._-]+$/.test(version)) {
    return res.status(400).json({ error: "กรุณาระบุเวอร์ชันเฟิร์มแวร์ที่ถูกต้อง (เช่น 1.2.0)" });
  }

  const urlCheck = validateOtaHttpsUrl(firmwareUrlRaw);
  if (!urlCheck.valid) {
    return res.status(400).json({ error: urlCheck.error });
  }

  if (!/^[a-f0-9]{64}$/.test(sha256Raw)) {
    return res.status(400).json({ error: "กรุณากรอกค่า SHA-256 ให้ครบ 64 ตัวอักษรฐานสิบหก (แยกช่องทางจากแหล่งไฟล์)" });
  }

  const activePort = findActiveChargingPort();
  if (activePort) {
    return res.status(409).json({
      error: `ไม่อนุญาตให้สั่งอัปเดต OTA ขณะพอร์ต ${activePort.label} กำลังชาร์จหรือรอชำระเงิน`,
    });
  }

  const otaId = generateRandomId("OTA");
  state.esp32Control.otaRelease = {
    otaId,
    version,
    firmwareUrl: urlCheck.url,
    sha256: sha256Raw,
    notes,
    force,
    createdAt: now(),
    createdBy: req.adminUser.email,
    status: "queued",
    statusUpdatedAt: now(),
    lastError: null,
  };

  state.updatedAt = now();
  addSystemLog("ADMIN", "warn", `ปล่อย OTA v${version} (${otaId}) รอ ESP32 ดึงเมื่อรีเลย์ว่างครบทุกช่อง`);
  addAuditLog(req.adminUser, "ESP32_OTA_DEPLOY", "esp32", {
    otaId,
    version,
    sha256: sha256Raw,
    firmwareUrl: urlCheck.url,
    force,
  });
  saveState();

  res.json({ success: true, esp32Control: sanitizeEsp32ControlForAdmin() });
});

app.post("/api/admin/esp32/ota/cancel", requireAdmin, (req, res) => {
  const prev = state.esp32Control.otaRelease;
  if (prev) {
    prev.status = "cancelled";
    prev.statusUpdatedAt = now();
    prev.cancelledBy = req.adminUser.email;
  }
  state.updatedAt = now();
  addSystemLog("ADMIN", "info", `ยกเลิกคำสั่ง OTA${prev?.version ? ` (v${prev.version})` : ""}`);
  addAuditLog(req.adminUser, "ESP32_OTA_CANCEL", "esp32", { otaId: prev?.otaId || null, version: prev?.version || null });
  saveState();
  res.json({ success: true, esp32Control: sanitizeEsp32ControlForAdmin() });
});

// ─── ESP32 Hardware Endpoints ─────────────────────────────────────────────────

app.get("/api/esp32/command", requireEsp32Auth, (req, res) => {
  const espIp = String(req.query?.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").replace(/^.*:/, "").trim();
  const rssi = req.query?.rssi ? Number(req.query.rssi) : null;
  const fwVersion = req.query?.fw ? String(req.query.fw).trim().slice(0, 32) : null;
  const partitionLabel = req.query?.part ? String(req.query.part).trim().slice(0, 24) : null;
  const otaPendingVerify = req.query?.otaPending === "1" || req.query?.otaPending === "true";
  const pollMs = req.query?.pollMs ? Number(req.query.pollMs) : null;
  const wifiSsid = req.query?.ssid ? String(req.query.ssid).trim().slice(0, 32) : null;

  const nowIso = now();
  const wasOffline = !state.lastEsp32?.lastSeen || (Date.now() - new Date(state.lastEsp32.lastSeen).getTime() > 15000);

  if (!state.lastEsp32) state.lastEsp32 = {};
  if (espIp) state.lastEsp32.ip = espIp;
  state.lastEsp32.lastSeen = nowIso;
  state.lastEsp32.status = "online";
  if (rssi !== null && Number.isFinite(rssi)) state.lastEsp32.rssi = rssi;
  if (fwVersion) state.lastEsp32.fwVersion = fwVersion;
  if (partitionLabel) state.lastEsp32.partitionLabel = partitionLabel;
  if (pollMs !== null && Number.isFinite(pollMs)) state.lastEsp32.pollIntervalMs = pollMs;
  if (wifiSsid) state.lastEsp32.wifiSsid = wifiSsid;
  state.lastEsp32.otaPendingVerify = otaPendingVerify;

  if (wasOffline) {
    addSystemLog("ESP32", "success", `บอร์ด ESP32 เชื่อมต่อสำเร็จ (${state.lastEsp32.ip || "online"}${fwVersion ? ` | FW ${fwVersion}` : ""}) พร้อมรับคำสั่ง`, {
      ip: state.lastEsp32.ip,
      rssi,
      fwVersion,
    });
  }

  // Expire stale one-shot commands
  const nowMs = Date.now();
  if (state.esp32Control.pendingCommand?.expiresAt && new Date(state.esp32Control.pendingCommand.expiresAt).getTime() <= nowMs) {
    state.esp32Control.pendingCommand = null;
  }
  if (state.esp32Control.pendingWifi?.expiresAt && new Date(state.esp32Control.pendingWifi.expiresAt).getTime() <= nowMs) {
    state.esp32Control.pendingWifi = null;
  }

  const safeIdleForMaintenance = areAllRelaysOff() && !findActiveChargingPort();

  const relays = {};
  Object.values(state.ports).forEach((p) => {
    relays[p.id] = {
      gpio: p.relayGpio,
      on: p.relayOn,
      isPaused: !!p.isPaused,
      remainingSeconds: p.remainingSeconds,
      sessionId: p.currentTx?.id || null,
    };
  });

  const ota = state.esp32Control.otaRelease;
  const shouldDeliverOta = Boolean(
    safeIdleForMaintenance &&
    ota &&
    ["queued", "deferred_port_active"].includes(ota.status) &&
    (ota.force || !fwVersion || fwVersion !== ota.version)
  );

  res.json({
    connected: true,
    serverHost: req.hostname || "localhost",
    serverTime: nowIso,
    espIp: state.lastEsp32.ip || null,
    relays,
    remoteConfig: {
      configVersion: state.esp32Control.remoteConfig.configVersion,
      pollIntervalMs: state.esp32Control.remoteConfig.pollIntervalMs,
      portGpioMap: state.esp32Control.remoteConfig.portGpioMap,
    },
    pendingCommand: safeIdleForMaintenance && state.esp32Control.pendingCommand
      ? {
          cmdId: state.esp32Control.pendingCommand.cmdId,
          action: state.esp32Control.pendingCommand.action,
        }
      : null,
    pendingWifi: safeIdleForMaintenance && state.esp32Control.pendingWifi
      ? {
          wifiCmdId: state.esp32Control.pendingWifi.wifiCmdId,
          ssid: state.esp32Control.pendingWifi.ssid,
          password: state.esp32Control.pendingWifi.password,
          timeoutSec: state.esp32Control.pendingWifi.timeoutSec,
        }
      : null,
    ota: shouldDeliverOta
      ? {
          otaId: ota.otaId,
          version: ota.version,
          firmwareUrl: ota.firmwareUrl,
          sha256: ota.sha256,
          force: !!ota.force,
        }
      : null,
    updatedAt: state.updatedAt,
  });
});

app.post("/api/esp32/report", requireEsp32Auth, (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const safeFields = {
    fwVersion: body.fwVersion ? String(body.fwVersion).slice(0, 32) : state.lastEsp32?.fwVersion || null,
    partitionLabel: body.partitionLabel ? String(body.partitionLabel).slice(0, 24) : state.lastEsp32?.partitionLabel || null,
    rollbackSupported: typeof body.rollbackSupported === "boolean" ? body.rollbackSupported : state.lastEsp32?.rollbackSupported ?? null,
    pollIntervalMs: Number.isFinite(Number(body.pollIntervalMs)) ? Number(body.pollIntervalMs) : state.lastEsp32?.pollIntervalMs || 2000,
    relayGpios: Array.isArray(body.relayGpios) ? body.relayGpios.slice(0, 4) : state.lastEsp32?.relayGpios || null,
    wifiSsid: body.wifiSsid ? String(body.wifiSsid).slice(0, 32) : state.lastEsp32?.wifiSsid || null,
    freeHeap: Number.isFinite(Number(body.freeHeap)) ? Number(body.freeHeap) : state.lastEsp32?.freeHeap || null,
    uptimeSec: Number.isFinite(Number(body.uptimeSec)) ? Number(body.uptimeSec) : state.lastEsp32?.uptimeSec || null,
    otaPendingVerify: typeof body.otaPendingVerify === "boolean" ? body.otaPendingVerify : !!state.lastEsp32?.otaPendingVerify,
  };

  state.lastEsp32 = {
    ...(state.lastEsp32 || {}),
    ...safeFields,
    receivedAt: now(),
    lastSeen: now(),
    status: "online",
  };

  // Acknowledge one-shot remote command (restart / hotspot)
  if (body.cmdId && state.esp32Control.pendingCommand?.cmdId === body.cmdId) {
    const cmdStatus = String(body.cmdStatus || "");
    const action = state.esp32Control.pendingCommand.action;
    if (["executed", "rejected", "cancelled"].includes(cmdStatus)) {
      state.esp32Control.pendingCommand = null;
      addSystemLog("ESP32", cmdStatus === "executed" ? "success" : "warn", `คำสั่ง ${action.toUpperCase()} (${body.cmdId}): ${cmdStatus}`);
    } else if (cmdStatus === "deferred_port_active") {
      addSystemLog("ESP32", "warn", `ชะลอคำสั่ง ${action.toUpperCase()} เนื่องจากยังมีรีเลย์เปิดจ่ายไฟอยู่`);
    }
  }

  // Acknowledge remote Wi-Fi change & wipe password from memory immediately
  if (body.wifiCmdId && state.esp32Control.pendingWifi?.wifiCmdId === body.wifiCmdId) {
    const wifiStatus = String(body.wifiStatus || "");
    const targetSsid = state.esp32Control.pendingWifi.ssid;
    if (["applied", "rolled_back", "failed"].includes(wifiStatus)) {
      state.esp32Control.pendingWifi = null; // clears Wi-Fi password from RAM
      addSystemLog(
        "ESP32",
        wifiStatus === "applied" ? "success" : "error",
        wifiStatus === "applied"
          ? `เปลี่ยน Wi-Fi เป็น "${targetSsid}" และเชื่อมเซิร์ฟเวอร์สำเร็จ`
          : `เปลี่ยน Wi-Fi เป็น "${targetSsid}" ไม่สำเร็จภายใน 60 วิ — Rollback กลับ Wi-Fi เดิมแล้ว`
      );
    } else if (wifiStatus === "deferred_port_active") {
      addSystemLog("ESP32", "warn", `ชะลอการเปลี่ยน Wi-Fi เนื่องจากยังมีพอร์ตจ่ายไฟอยู่`);
    }
  }

  // Track OTA lifecycle
  if (body.otaStatus) {
    const otaStatus = String(body.otaStatus).slice(0, 32);
    const otaError = body.otaError ? String(body.otaError).slice(0, 200) : null;
    const ota = state.esp32Control.otaRelease;
    if (ota && (!body.otaId || ota.otaId === body.otaId)) {
      ota.status = otaStatus;
      ota.statusUpdatedAt = now();
      ota.lastError = otaError;
    }
    const level = otaStatus === "verified" ? "success" : (["failed", "rolled_back"].includes(otaStatus) ? "error" : "warn");
    addSystemLog("ESP32", level, `OTA Status: ${otaStatus}${otaError ? ` (${otaError})` : ""}${safeFields.fwVersion ? ` [FW ${safeFields.fwVersion}]` : ""}`);
    saveState();
  }

  if (body.configStatus === "rejected_gpio_allowlist") {
    addSystemLog("ESP32", "error", "ESP32 ปฏิเสธการตั้งค่า GPIO ที่ไม่อยู่ใน Allowlist [25, 26, 27, 33]");
  }

  state.updatedAt = now();
  res.json({ success: true });
});

// ─── Issues & Support Tickets ─────────────────────────────────────────────────
function loadIssuesFile() {
  try {
    if (fs.existsSync(ISSUES_FILE)) {
      const data = JSON.parse(fs.readFileSync(ISSUES_FILE, "utf8"));
      if (Array.isArray(data)) return data;
    }
  } catch (_) {}
  return [];
}

function saveIssuesFile(issues) {
  try {
    fs.writeFileSync(ISSUES_FILE, JSON.stringify(issues, null, 2), "utf8");
  } catch (_) {}
}

app.get("/api/issues", async (req, res) => {
  const issues = loadIssuesFile();
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const adminUser = await verifyAdminBearer(auth.slice(7).trim());
    if (adminUser) return res.json({ issues });
  }
  const publicIssues = issues.filter((x) => x.reply && x.reply.isPublic);
  res.json({ issues: publicIssues });
});

app.post("/api/issues", limiterIssues, (req, res) => {
  const issue = req.body;
  if (!issue || !issue.description) {
    return res.status(400).json({ error: "กรุณาระบุรายละเอียดปัญหา" });
  }
  const issues = loadIssuesFile();

  let safeImageUrl = "";
  if (issue.imageUrl && typeof issue.imageUrl === "string") {
    const trimmed = issue.imageUrl.trim();
    if (trimmed.startsWith("data:image/") && trimmed.length <= 1.5 * 1024 * 1024) {
      safeImageUrl = trimmed;
    } else if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      safeImageUrl = trimmed.slice(0, 2048);
    }
  }

  const issueId = (typeof issue.id === "string" && /^ISS(?:UE)?-\d{4,10}$/.test(issue.id))
    ? issue.id
    : generateRandomId("ISSUE", issues.map((x) => x.id));

  const newIssue = {
    id: issueId,
    visitorId: sanitizeTaggedId(issue.visitorId, "USR") || null,
    createdAt: issue.createdAt || now(),
    category: String(issue.category || "other").slice(0, 30),
    categoryLabel: String(issue.categoryLabel || "ทั่วไป").slice(0, 50),
    portId: String(issue.portId || "all").slice(0, 20),
    portLabel: String(issue.portLabel || "ทั่วไป").slice(0, 30),
    amount: Number(issue.amount) || 0,
    contact: String(issue.contact || "—").slice(0, 60),
    description: String(issue.description).slice(0, 1000),
    imageUrl: safeImageUrl,
    status: "pending",
    reply: null,
  };

  issues.unshift(newIssue);
  if (issues.length > 300) issues.pop();
  saveIssuesFile(issues);

  if (firestoreEnabled && db) {
    db.collection("issues").doc(newIssue.id).set(newIssue).catch(() => {});
  }

  addSystemLog("ISSUE", "info", `มีแจ้งปัญหาใหม่ [${newIssue.id}] (${newIssue.categoryLabel})`);
  res.json({ success: true, issue: newIssue });
});

app.post("/api/issues/:id/reply", requireAdmin, (req, res) => {
  const id = req.params.id;
  const { status, message, isPublic } = req.body;
  const issues = loadIssuesFile();
  const target = issues.find((x) => x.id === id);
  if (!target) return res.status(404).json({ error: "ไม่พบรายการแจ้งปัญหานี้" });

  target.status = status || target.status;
  target.reply = {
    adminName: req.adminUser.email || "ผู้ดูแลระบบ",
    message: String(message || (status === "resolved" ? "ผู้ดูแลได้ตรวจสอบและแก้ไขเรียบร้อยแล้ว" : "กำลังดำเนินการตรวจสอบ")).slice(0, 1000),
    repliedAt: now(),
    isPublic: !!isPublic,
  };
  saveIssuesFile(issues);

  if (firestoreEnabled && db) {
    db.collection("issues").doc(id).set(target, { merge: true }).catch(() => {});
  }

  addAuditLog(req.adminUser, "REPLY_ISSUE", id, { status: target.status, isPublic: !!isPublic });
  res.json({ success: true, issue: target });
});

app.delete("/api/issues/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  let issues = loadIssuesFile();
  if (id === "all") {
    issues = [];
  } else {
    issues = issues.filter((x) => x.id !== id);
  }
  saveIssuesFile(issues);
  addAuditLog(req.adminUser, "DELETE_ISSUE", id);
  res.json({ success: true, count: issues.length });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes("รูปแบบ")) {
    return res.status(400).json({ error: err.message });
  }
  console.error("[ERR] Unhandled server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start Server & Restore Cloud State ───────────────────────────────────────
app.listen(PORT, async () => {
  await restoreFromFirestore();
  console.log("");
  console.log("[BOOT] Smart USB Charger Server v3");
  console.log(`       URL:       http://localhost:${PORT}`);
  console.log(`       Admin:     http://localhost:${PORT}/admin (Google Auth Only)`);
  console.log(`       Rate:      1 THB = ${CFG.secondsPerBaht}s`);
  console.log(`       EasySlip:  ${CFG.easyslipKey ? "Enabled" : "Not configured (dev mode)"}`);
  console.log(`       ESP32 Key: ${CFG.esp32Secret ? "Configured" : "MISSING (set ESP32_SECRET)"}`);
  console.log(`       Firestore: ${firestoreEnabled ? "Connected" : "Offline (local JSON fallback)"}`);
  console.log("");
});
