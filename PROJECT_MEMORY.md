# PROJECT MEMORY & ARCHITECTURE CONTEXT
> **Smart USB Charger (ตู้ชาร์จมือถืออัจฉริยะ 4 ช่อง)**
> เอกสารอ้างอิงสถาปัตยกรรม ความปลอดภัย และโครงสร้างข้อมูลหลักของโปรเจกต์

---

## 1. ภาพรวมและเป้าหมายของระบบ (Project Mission & Vision)
- **วัตถุประสงค์:** ระบบควบคุมตู้ชาร์จแบตเตอรี่โทรศัพท์มือถืออัจฉริยะ 4 พอร์ต (USB-A 2 ช่อง, USB-C 2 ช่อง) สำหรับใช้งานจริงในสถานศึกษาหรือพื้นที่สาธารณะ
- **ผู้จัดทำ:** คณะผู้จัดทำโครงงาน ชั้นมัธยมศึกษาปีที่ 3/13
- **ประสบการณ์ผู้ใช้ (UX/UI):**
  - อินเทอร์เฟซ Modern Kiosk รองรับ Dark/Light Mode, SVG ไอคอนสะอาดตา, เสียงพูดภาษาไทย (Voice Guidance) และ Animation แบบ GPU-composited (`transform`/`opacity`)
  - สถานะพอร์ตแบบ Real-time:
    - **ว่าง** (`available`)
    - **ไม่ว่าง / กำลังชำระเงิน** (`pending_payment`) เมื่อมีผู้กำลังทำรายการหรือรอตรวจสลิป
    - **กำลังจ่ายไฟ** (`in-use`) พร้อมแถบสถานะแบบ `scaleX` และเวลานับถอยหลัง

---

## 2. สถาปัตยกรรมระบบ (System Architecture)

```text
[ ลูกค้าหน้าตู้ / มือถือ ]           [ ฮาร์ดแวร์ตู้ชาร์จ (ESP32) ]
        |                                    |
        | HTTPS / REST                       | Poll ทุก 2 วินาที (Header X-ESP32-Secret)
        v                                    v
[ Firebase Hosting ] --(API Request)--> [ Render Cloud Server ]
(usb-charger-project.web.app)          (charging-server.js)
        |                                    |
        +-----------> [ Firestore ] <--------+
                   (State & Logs Sync)
```

1. **Frontend (Kiosk & Admin UI):**
   - Host: **Firebase Hosting** (`https://usb-charger-project.web.app`)
   - ไฟล์หลัก: `public/index.html` (หน้าตู้ชาร์จ) และ `public/admin.html` (หน้าแดชบอร์ดแอดมิน)
2. **Backend Server (API & Hardware Controller):**
   - Host: **Render Cloud** (`https://usb-charger.onrender.com`)
   - โค้ดหลัก: `charging-server.js` (Node.js + Express, Entry point: `server.js`)
3. **Database & Real-time State:**
   - **Google Firebase Firestore** (Project: `usb-charger-project`)
   - Collections หลัก:
     - `charger/charger01`: สถานะพอร์ต, Config สาธารณะ, และสถิติสรุป (Public Read, Server-only Write)
     - `charger_private/state`: `usedTransRefs` และข้อมูลบัญชีรับเงินภายใน (Server-only / No client access)
     - `transactions/{txId}`: ประวัติธุรกรรม `TX-XXXXXX` (ระบุผู้จ่าย `USR-XXXXXX` -> ผู้รับ, พอร์ต, เวลา, ช่องทาง)
     - `visits/{visitId}`: ประวัติผู้เข้าชมเว็บไซต์ `VIS-XXXXXX` พร้อม `visitorId` (`USR-XXXXXX`) และชนิดอุปกรณ์
     - `pending_approvals/{pendingId}`: คิวรออนุมัติสลิปด้วยมือ `PEN-XXXXXX`
     - `audit_logs/{logId}`: บันทึกการกระทำของผู้ดูแล `AUD-XXXXXX`
     - `issues/{issueId}`: รายการแจ้งปัญหาจากผู้ใช้งาน `ISSUE-XXXXXX`
     - `admin_whitelist/{email}`: รายชื่ออีเมล Google ที่ได้รับสิทธิ์เข้าใช้งาน Admin Portal
4. **Hardware Controller (Microcontroller):**
   - บอร์ด: **DOIT ESP32 DEVKIT V1**
   - โค้ด: `esp32-demo/esp32-demo.ino`

---

## 3. ฮาร์ดแวร์และพินรีเลย์ (Hardware GPIO Mapping & Fail-Safe)

| ช่องชาร์จ | ชนิดพอร์ต | พิน ESP32 (GPIO) | รีเลย์ (Active-High) |
| :--- | :--- | :--- | :--- |
| **พอร์ต 1** | USB-A 1 | **GPIO 26** | Relay 1 (`LOW` = ตัดไฟ, `HIGH` = จ่ายไฟ) |
| **พอร์ต 2** | USB-A 2 | **GPIO 27** | Relay 2 (`LOW` = ตัดไฟ, `HIGH` = จ่ายไฟ) |
| **พอร์ต 3** | USB-C 1 | **GPIO 25** | Relay 3 (`LOW` = ตัดไฟ, `HIGH` = จ่ายไฟ) |
| **พอร์ต 4** | USB-C 2 | **GPIO 33** | Relay 4 (`LOW` = ตัดไฟ, `HIGH` = จ่ายไฟ) |
| **ปุ่มตั้งค่า Wi-Fi** | ปุ่ม BOOT | **GPIO 0** | กดค้าง 3 วินาที เพื่อเปิด Captive Portal |

### มาตรฐานความปลอดภัยของเฟิร์มแวร์ ESP32
- กำหนดโหมด `OUTPUT` และเขียน `LOW` ให้รีเลย์ทั้ง 4 ช่องเป็นลำดับแรกสุดใน `setup()` ก่อนเริ่ม Wi-Fi เพื่อป้องกันไฟกระตุกเปิดรีเลย์ตอนบูต
- ใช้ Captive Portal (`SmartCharger-Setup` ที่ `192.168.4.1`) สำหรับตั้งค่า Wi-Fi, Server URL และ `ESP32_SECRET` ลง Flash Memory (`Preferences`) โดยไม่ฝังรหัสผ่านจริงไว้ในโค้ด
- ส่งความลับผ่าน HTTP Header `X-ESP32-Secret` เท่านั้น (ไม่ส่งผ่าน URL Query String เพื่อป้องกันการรั่วใน Server Access Logs)
- มีตัวจับเวลา Fail-Safe ระดับฮาร์ดแวร์ (`millis()`) ตามค่า `remainingSeconds` ของแต่ละพอร์ต เพื่อสั่งตัดไฟอัตโนมัติทันทีเมื่อหมดเวลาแม้สัญญาณ Wi-Fi ขาดหาย

---

## 4. ช่องทางการชำระเงินและระบบรหัสติดตาม (Random IDs)

1. **รูปแบบรหัสอ้างอิงสุ่ม (Cryptographic Random 6 Digits):**
   - `USR-XXXXXX`: รหัสผู้ใช้งาน/ผู้เข้าชมที่สร้างและจดจำไว้ต่ออุปกรณ์
   - `VIS-XXXXXX`: รหัสการเข้าชมเว็บไซต์แต่ละครั้ง (ป้องกันนับซ้ำในระยะสั้นและซิงค์ลง Firestore)
   - `TX-XXXXXX`: รหัสธุรกรรมชำระเงินและการชาร์จ (ระบุผู้จ่าย `payerId`/`payerName` -> ผู้รับ `receiverName`/`receiverAccount` พอร์ต และเวลาโอน)
   - `PEN-XXXXXX`: รหัสคำขอตรวจสลิปด้วยมือเมื่อระบบตรวจอัตโนมัติไม่สามารถยืนยันได้
   - `AUD-XXXXXX`: รหัส Audit Log ของการดำเนินการโดย Admin
   - `ISSUE-XXXXXX`: รหัสเรื่องแจ้งปัญหาการใช้งาน
2. **ช่องทางชำระเงิน:**
   - **พร้อมเพย์ QR Code (PromptPay):** ตรวจสลิปอัตโนมัติผ่าน EasySlip API
   - **โอนเงินเข้าบัญชีธนาคาร:** ตรวจสลิปอัตโนมัติเทียบชื่อบัญชี/เลขบัญชีที่ตั้งค่าไว้
   - **TrueMoney Wallet:** รองรับซองของขวัญ TrueMoney Voucher (`gift.truemoney.com`) และการอัปโหลดสลิป (กรณีไม่มี BOT QR หรือ EasySlip ขัดข้อง จะเข้าคิว `PEN-XXXXXX` รอแอดมินกดอนุมัติแทนการจ่ายไฟอัตโนมัติ)
   - **หยอดเหรียญ (Coin Acceptor):** รองรับเหรียญ 5 และ 10 บาท (อัตราเริ่มต้น: 1 บาท = 180 วินาที ปรับได้ในหน้า Admin)

---

## 5. ระบบสิทธิ์ผู้ดูแลระบบ (Google Sign-In Only — ไม่มี PIN)

- **การยืนยันตัวตน:** ใช้ **Google Sign-In ผ่าน Firebase Authentication** ร่วมกับ Firestore `admin_whitelist` และ Render ENV `ADMIN_EMAILS` เท่านั้น
- **Zero PIN Policy:** ยกเลิกระบบ PIN, รหัสผ่านสำรอง, และการบายพาสด้วย LAN IP โดยสมบูรณ์
- ทุก Admin API endpoint (`/api/admin/*`, `/api/issues/:id/reply`, `DELETE /api/issues/:id`) ตรวจสอบ Firebase ID Token แบบ Real-time ผ่าน `firebase-admin` และบันทึก `audit_logs`

---

## 6. ตัวแปรสภาพแวดล้อมที่ต้องตั้งค่าบน Render (Environment Variables)

- `PROMPTPAY_PHONE`: เบอร์พร้อมเพย์รับเงิน (เช่น `0xxxxxxxxx`)
- `TRUEMONEY_PHONE`: เบอร์ TrueMoney Wallet สำหรับรับซองของขวัญและแจ้งโอน
- `BANK_NAME`: ชื่อธนาคารรับโอน
- `BANK_ACCOUNT`: เลขบัญชีธนาคารรับโอน
- `BANK_ACCOUNT_NAME`: ชื่อเจ้าของบัญชี (ใช้เทียบชื่อผู้รับในสลิป EasySlip)
- `SECONDS_PER_BAHT`: อัตราวินาทีต่อ 1 บาท (ค่าเริ่มต้น `180`)
- `EASYSLIP_API_KEY`: API Key จาก EasySlip สำหรับตรวจสอบสลิปอัตโนมัติ
- `ESP32_SECRET`: Secret Key สำหรับยืนยันตัวตนบอร์ด ESP32 ผ่าน `X-ESP32-Secret`
- `ADMIN_EMAILS`: อีเมล Google ของผู้ดูแลระบบ (คั่นด้วย `,`)
- `FIREBASE_SERVICE_ACCOUNT`: JSON Key ของ Firebase Service Account
- `ALLOWED_ORIGINS`: รายชื่อโดเมนต้นทางที่อนุญาตสำหรับ CORS

---

## 7. ข้อมูลบริบทโครงงาน (Academic Context)
- **กลุ่มตัวอย่าง:** นักเรียนชั้นมัธยมศึกษาปีที่ 3/13 จำนวน **26 คน** ($N = 26$)
- **ผลการประเมินความพึงพอใจ:** ค่าเฉลี่ยรวม $\bar{x} = 4.67, S.D. = 0.49$ (ระดับความพึงพอใจมากที่สุด)
