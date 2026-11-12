# Antigravity Workspace Instruction & Memory
> You are working on the **Smart USB Charger (ตู้ชาร์จมือถืออัจฉริยะ 4 ช่อง)** project.

Always read `PROJECT_MEMORY.md` at the root of this workspace. It contains the architecture, pin mappings, authentication model, Firestore collections, randomized ID conventions, and security rules.

Key highlights:
- 4 Ports: USB-A 1 (GPIO 26), USB-A 2 (GPIO 27), USB-C 1 (GPIO 25), USB-C 2 (GPIO 33).
- SoftAP Captive Portal: `SmartCharger-Setup` at `192.168.4.1` (hold BOOT GPIO 0 for 3s to trigger; configure AP passphrase & Wi-Fi via portal/firmware NVS — never commit real credentials).
- Cloud Backend: `https://usb-charger.onrender.com` (`charging-server.js`)
- Frontend: `https://usb-charger-project.web.app` (`public/index.html`, `public/admin.html`)
- Admin Security: **Google Sign-In only** (Firebase ID Token verified by `firebase-admin` + Firestore `admin_whitelist` / ENV `ADMIN_EMAILS`). Legacy PIN/password login is permanently removed.
- Payment Config: Configured at runtime via Render ENV (`PROMPTPAY_PHONE`, `TRUEMONEY_PHONE`, `BANK_NAME`, `BANK_ACCOUNT`, `BANK_ACCOUNT_NAME`, `EASYSLIP_API_KEY`, `ESP32_SECRET`, `ADMIN_EMAILS`, `FIREBASE_SERVICE_ACCOUNT`, `ALLOWED_ORIGINS`) or stored securely via `/api/admin/config`. Never hardcode PII or secrets in repository files.
- Traceable Randomized IDs: `USR-XXXXXX`, `VIS-XXXXXX`, `TX-XXXXXX`, `PEN-XXXXXX`, `AUD-XXXXXX`, `ISSUE-XXXXXX`.
- Port Holding & Payment Safety: Single source of truth on backend. Unverified slips (including TrueMoney slips without BOT QR or EasySlip outage) return HTTP `202` and enter `pending_approvals` for Admin approval — never auto-activate power without verification.
