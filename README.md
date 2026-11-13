# ⚡ ตู้ชาร์จมือถืออัจฉริยะ 4 ช่อง (Smart USB Charger Station)
> **โครงการตู้ชาร์จแบตเตอรี่โทรศัพท์มือถืออัจฉริยะสาธารณะ ควบคุมผ่าน IoT และ Cloud Architecture**  
> จัดทำโดย: คณะผู้จัดทำโครงงาน ชั้นมัธยมศึกษาปีที่ 3/13

---

## 📑 สารบัญ
1. [ส่วนที่ 1: ฮาร์ดแวร์ (Hardware Architecture)](#ส่วนที่-1-ฮาร์ดแวร์-hardware-architecture)
   - [1.1 รายการอุปกรณ์หลัก](#11-รายการอุปกรณ์หลัก)
   - [1.2 แผนผังการต่อวงจร (Wiring Diagram)](#12-แผนผังการต่อวงจร-wiring-diagram)
   - [1.3 ตารางแมปปิ้งขา GPIO & รีเลย์](#13-ตารางแมปปิ้งขา-gpio--รีเลย์)
   - [1.4 ระบบความปลอดภัยทางไฟฟ้าและ Fail-Safe](#14-ระบบความปลอดภัยทางไฟฟ้าและ-fail-safe)
2. [ส่วนที่ 2: ซอฟต์แวร์ (Software Architecture)](#ส่วนที่-2-ซอฟต์แวร์-software-architecture)
   - [2.1 สถาปัตยกรรมระบบ 3 ชั้น (3-Tier Cloud Stack)](#21-สถาปัตยกรรมระบบ-3-ชั้น-3-tier-cloud-stack)
   - [2.2 เว็บแอปพลิเคชันหน้าตู้ (Kiosk Frontend)](#22-เว็บแอปพลิเคชันหน้าตู้-kiosk-frontend)
   - [2.3 เซิร์ฟเวอร์ประมวลผล (Backend Server API)](#23-เซิร์ฟเวอร์ประมวลผล-backend-server-api)
   - [2.4 ฐานข้อมูลและการรักษาความปลอดภัย (Firestore & Rules)](#24-ฐานข้อมูลและการรักษาความปลอดภัย-firestore--rules)
   - [2.5 เฟิร์มแวร์ไมโครคอนโทรลเลอร์ (ESP32 Firmware & OTA)](#25-เฟิร์มแวร์ไมโครคอนโทรลเลอร์-esp32-firmware--ota)
3. [ส่วนที่ 3: รายละเอียดทั้งหมดและการทำงานของระบบ (Full System Specifications)](#ส่วนที่-3-รายละเอียดทั้งหมดและการทำงานของระบบ-full-system-specifications)
   - [3.1 โฟลว์การทำงานแบบครบวงจร (End-to-End Operational Flow)](#31-โฟลว์การทำงานแบบครบวงจร-end-to-end-operational-flow)
   - [3.2 โครงสร้างไฟล์และโฟลเดอร์ของโปรเจกต์ (Project Structure)](#32-โครงสร้างไฟล์และโฟลเดอร์ของโปรเจกต์-project-structure)
   - [3.3 การติดตั้งและตั้งค่าระบบ (Setup & Deployment Guide)](#33-การติดตั้งและตั้งค่าระบบ-setup--deployment-guide)
   - [3.4 รายการตัวแปรสภาพแวดล้อม (Environment Variables)](#34-รายการตัวแปรสภาพแวดล้อม-environment-variables)

---

# ส่วนที่ 1: ฮาร์ดแวร์ (Hardware Architecture)

ระบบฮาร์ดแวร์ถูกออกแบบโดยคำนึงถึง **ความปลอดภัยของผู้ใช้งาน (Human Safety)** และ **ความเสถียรในการทำงานต่อเนื่องตลอด 24 ชั่วโมง (High Reliability)** ในพื้นที่สาธารณะหรือโรงเรียน

```text
               +-------------------------------------------------------+
               |                  แหล่งจ่ายไฟ Switching 5V             |
               +---------------------------+---------------------------+
                                           | (+5V VBUS)
                                           v
[บอร์ด ESP32 DEVKIT V1] ---> [4-Channel Relay Module] ---> [4x พอร์ตชาร์จ USB]
  - GPIO 26                    - Relay 1 (COM -> NO)         - พอร์ต 1: USB-A 1
  - GPIO 27                    - Relay 2 (COM -> NO)         - พอร์ต 2: USB-A 2
  - GPIO 25                    - Relay 3 (COM -> NO)         - พอร์ต 3: USB-C 1
  - GPIO 33                    - Relay 4 (COM -> NO)         - พอร์ต 4: USB-C 2
                                           | (GND)
                                           v
               +-------------------------------------------------------+
               |                  Common Ground (-0V)                  |
               +-------------------------------------------------------+
```

### 1.1 รายการอุปกรณ์หลัก
1. **ไมโครคอนโทรลเลอร์:** DOIT ESP32 DEVKIT V1 (30 ขา, Dual-Core 240MHz, 2.4GHz Wi-Fi 802.11 b/g/n, Flash 4MB)
2. **โมดูลรีเลย์ (Relay Module):** 4 ช่อง (4-Channel 5V Relay with Optocoupler Isolation, ทนกระแสหน้าสัมผัส 10A 250VAC / 10A 30VDC)
3. **พอร์ตชาร์จไฟ (USB Sockets):** 
   - 2x พอร์ต USB Type-A (High-Current Fast Charge Support)
   - 2x พอร์ต USB Type-C (Power Delivery / Standard 5V High Current)
4. **แหล่งจ่ายไฟ (Power Supply):** สวิตชิ่งเพาเวอร์ซัพพลาย 220VAC แปลงเป็น 5VDC (ขนาดขั้นต่ำ 5V 10A-15A) พร้อมวงจร Step-down สำหรับบอร์ดและอุปกรณ์ย่อย
5. **อุปกรณ์เสริมความปลอดภัย:** ฟิวส์ตัดกระแสเกิน (Fast-acting Fuse) ประจำแต่ละพอร์ตชาร์จ, ไดโอดป้องกันกระแสย้อนกลับ (Flyback Diode), และกล่องควบคุมมาตรฐานฉนวนกันไฟ

---

### 1.2 แผนผังการต่อวงจร (Wiring Diagram)

#### ก. การต่อไฟเลี้ยงบอร์ดและรีเลย์ (Power Wiring)
| ขารีเลย์ (Relay) | ขา ESP32 | แหล่งจ่ายไฟ (Power Supply 5V) | คำอธิบาย |
|---|---|---|---|
| **VCC** | VIN (5V) | +5V (Positive) | จ่ายไฟเลี้ยงโมดูลรีเลย์และเรกูเลเตอร์บนบอร์ด ESP32 |
| **GND** | GND | -0V (Ground) | กราวด์ร่วมกันทั้งหมดของระบบ (Common Ground) |

#### ข. วงจรตัดต่อกระแสไฟไปยังหัวชาร์จ USB (Load Circuit)
วงจรจะทำการตัดต่อ **เฉพาะสายขั้วบวก (+5V VBUS)** ของสายชาร์จเท่านั้น ส่วนสายขั้วลบ (GND) จะต่อลงกราวด์ร่วมตลอดเวลา:
```text
แหล่งจ่ายไฟ 5V (+) --------> Relay Terminal [COM] (ขากลาง)
                             Relay Terminal [NO]  (หน้าสัมผัสปกติเปิด) ----> ขั้วบวกสาย USB (+5V แดง)
แหล่งจ่ายไฟ 5V (-) -----------------------------------------------------> ขั้วลบสาย USB (GND ดำ)
```

---

### 1.3 ตารางแมปปิ้งขา GPIO & รีเลย์

ระบบคัดเลือกเฉพาะขาพินที่ปลอดภัย (Safe Boot Pins) หลีกเลี่ยง Strapping Pins ที่ทำให้เกิดปัญหาตอนเปิดเครื่อง:

| ช่องชาร์จ | ชนิดพอร์ต | ขารีเลย์ | ขา ESP32 GPIO | โหมดควบคุม | ตรรกะคำสั่ง (Active-High) |
|---|---|---|---|---|---|
| **พอร์ต 1** | USB-A 1 | IN 1 | **GPIO 26** | OUTPUT | `HIGH` = เปิดไฟชาร์จ / `LOW` = ตัดไฟ |
| **พอร์ต 2** | USB-A 2 | IN 2 | **GPIO 27** | OUTPUT | `HIGH` = เปิดไฟชาร์จ / `LOW` = ตัดไฟ |
| **พอร์ต 3** | USB-C 1 | IN 3 | **GPIO 25** | OUTPUT | `HIGH` = เปิดไฟชาร์จ / `LOW` = ตัดไฟ |
| **พอร์ต 4** | USB-C 2 | IN 4 | **GPIO 33** | OUTPUT | `HIGH` = เปิดไฟชาร์จ / `LOW` = ตัดไฟ |

---

### 1.4 ระบบความปลอดภัยทางไฟฟ้าและ Fail-Safe
- **ระบบแยกส่วนแรงดันไฟสมบูรณ์ (Low Voltage Isolation):** ภายในตู้ชาร์จไม่มีการนำไฟบ้าน 220VAC เข้ามาใกล้จุดสัมผัสของลูกค้า วงจรทุกจุดใช้แรงดันต่ำไม่เกิน 5VDC
- **Boot Default State:** ทุกขา GPIO จะถูกสั่ง `digitalWrite(pin, LOW)` ทันทีในบรรทัดแรกของฟังก์ชัน `setup()` เพื่อให้แน่ใจว่าเมื่อตู้เริ่มทำงาน ไฟชาร์จจะดับสนิททุกช่อง
- **Local Hardware Timer Fail-Safe:** บอร์ด ESP32 มีระบบนับถอยหลังตัดไฟในตัวเอง หากเน็ตโรงเรียนหลุดระหว่างการชาร์จ บอร์ดจะตัดไฟตามเวลาที่ได้รับมอบหมายอย่างแม่นยำ ไม่เปิดไฟค้างทิ้งไว้

---

# ส่วนที่ 2: ซอฟต์แวร์ (Software Architecture)

ซอฟต์แวร์ของระบบทำงานร่วมกันแบบไร้รอยต่อระหว่าง Frontend, Backend Cloud, Cloud Firestore และ Microcontroller Firmware:

```text
[ ผู้ใช้หน้าตู้ / มือถือ ]           [ บอร์ด ESP32 ตู้ชาร์จ ]
        |                                    |
        | HTTPS / WSS                        | HTTPS Poll (ทุก 2 วิ)
        v                                    v
+-----------------------+           +-----------------------+
|   Firebase Hosting    |           |   Render Cloud Server |
| (Kiosk & Admin Web)   |           |  (charging-server.js) |
+-----------+-----------+           +-----------+-----------+
            |                                   |
            +--------------> [ Firestore ] <----+
                       (Real-time State & Logs)
```

### 2.1 สถาปัตยกรรมระบบ 3 ชั้น (3-Tier Cloud Stack)
1. **Presentation Layer (Frontend):** โฮสต์บน **Firebase Hosting** รองรับ CDN ทั่วโลก โหลดเร็ว ปลอดภัยด้วย SSL/TLS อัตโนมัติ
2. **Application Layer (Backend):** โฮสต์บน **Render Cloud** เขียนด้วย Node.js 20 LTS ทำหน้าที่คำนวณราคา, ตรวจสลิป, ตรวจสอบความถูกต้อง, และสื่อสารกับฮาร์ดแวร์
3. **Database Layer (Storage & Sync):** **Google Cloud Firestore** ทำหน้าที่เก็บสถานะพอร์ตแบบ Real-time, บันทึกบัญชีธุรกรรม, Audit Log, และ Whitelist

---

### 2.2 เว็บแอปพลิเคชันหน้าตู้ (Kiosk Frontend)
- **ไฟล์หลัก:** `public/index.html` (พัฒนาด้วย Modern Vanilla JavaScript และ CSS Variables โดยไม่พึ่งพา Framework หนักๆ เพื่อให้โหลดได้เร็วที่สุดบนหน้าจอสัมผัสตู้)
- **ฟังก์ชันสำคัญ:**
  - **Dynamic Theme:** รองรับโหมดมืด (Dark Mode) และโหมดสว่าง (Light Mode)
  - **Interactive Port Cards:** แสดงสถานะพอร์ต 4 ช่อง (`available`, `pending_payment`, `in-use`) พร้อมแถบเวลาถอยหลังแบบ GPU Acceleration (`scaleX`)
  - **Voice & Audio Feedback:** ระบบสังเคราะห์เสียงพูดภาษาไทยสไตล์ตู้เต่าบิน (Web Speech API) และเสียง Sound Effect แนะนำผู้ใช้ทุกขั้นตอน
  - **ระบบหยุดชาร์จก่อนเวลา (Early Stop):** ผู้ใช้สามารถกดตัดไฟก่อนเวลาได้หากต้องรีบไปเรียน พร้อมกล่องยืนยันป้องกันการกดผิด
  - **Real-time Slip Approval Tracker:** หน้าตู้ตรวจจับการอนุมัติสลิปของแอดมินผ่าน Firestore Listener ทันที ไม่ต้องรอนับเวลาถอยหลังซ้ำ
  - **แถบเมนูหัวเว็บ (Topbar Navigation):**
    - ปุ่มทำแบบประเมินความพึงพอใจ (Google Forms)
    - ปุ่ม Instagram ติดต่อผู้ดูแล (ซิงก์ข้อมูลจากระบบแบบเรียลไทม์)
    - ปุ่มแชร์ QR Code ตู้ชาร์จสำหรับเปิดบนมือถือ

---

### 2.3 เซิร์ฟเวอร์ประมวลผล (Backend Server API)
- **ไฟล์หลัก:** `charging-server.js` (Express.js Framework)
- **หน้าที่หลัก:**
  1. **ระบบตรวจสอบสลิปอัตโนมัติ (Automated Slip Verification):**
     - เชื่อมต่อกับ EasySlip API ตรวจสอบความถูกต้องของสลิปโอนเงินธนาคาร
     - ป้องกันการโกงและการใช้สลิปซ้ำ 100% ด้วยการตรวจรหัสอ้างอิงธุรกรรม (`transRef`) และคำนวณ SHA-256 Hash ของรูปภาพ
     - ป้องกัน Race Condition และ Double Payment ด้วย Atomic In-flight Locks
  2. **ระบบชำระเงิน TrueMoney Wallet:**
     - ตรวจสอบและดึงเงินจากซองอั่งเปา TrueMoney Wallet อัตโนมัติ
  3. **ศูนย์กลางคำสั่ง ESP32 (`/api/esp32/command`):**
     - ส่งสถานะเปิด/ปิดไฟของพอร์ตทั้ง 4 ให้บอร์ด ESP32 ผ่านการเข้ารหัสลับด้วย Shared Secret Header (`X-ESP32-Secret`)
  4. **ระบบความปลอดภัย Zero PIN Policy:**
     - ยกเลิกการใช้รหัส PIN หรือ Password ที่เสี่ยงต่อการถูกดักฟัง บังคับใช้การยืนยันตัวตนด้วย Google Sign-In ผ่าน Firebase Authentication เท่านั้น

---

### 2.4 ฐานข้อมูลและการรักษาความปลอดภัย (Firestore & Rules)
- **ไฟล์กำหนดสิทธิ์:** `firestore.rules`
- **โครงสร้าง Collections หลัก:**
  - `charger/charger01`: เก็บสถานะพอร์ตทั้ง 4, ค่าบริการปัจจุบัน, ข้อมูลติดต่อ IG, จุดติดตั้ง (อ่านสาธารณะ / แอดมินและเซิร์ฟเวอร์แก้ไขได้)
  - `charger_private/state`: เก็บข้อมูลภายใน เช่น ประวัติรหัสสลิปที่ใช้แล้ว (`usedTransRefs`) เพื่อความปลอดภัยขั้นสูง (เซิร์ฟเวอร์อ่านเขียนได้เท่านั้น)
  - `transactions`: บันทึกประวัติการชาร์จเงินเข้าตู้ทุกรายการ (`TX-XXXXXX`)
  - `pending_approvals`: คิวตรวจสลิปด้วยมือของแอดมินสำหรับสลิปที่ระบบอัตโนมัติตรวจไม่ผ่าน
  - `admin_whitelist`: รายชื่ออีเมล Google ที่ได้รับอนุญาตให้เข้าถึงระบบจัดการแอดมิน
  - `audit_logs`: บันทึกประวัติการกระทำของแอดมินทุกครั้ง เช่น การอนุมัติสลิป การแก้ราคา หรือการรีสตาร์ตตู้

---

### 2.5 เฟิร์มแวร์ไมโครคอนโทรลเลอร์ (ESP32 Firmware & OTA)
- **ไฟล์หลัก:** `esp32-demo/esp32-demo.ino`
- **คุณสมบัติเด่น:**
  - **WiFi Auto-Reconnect & Heartbeat:** ตรวจสอบสัญญาณเน็ตตลอดเวลา หากหลุดจะพยายามเชื่อมต่อใหม่แบบ Exponential Backoff และส่ง Heartbeat รายงานสถานะให้แอดมินทราบ
  - **Remote Config:** รองรับการปรับเปลี่ยนความถี่ในการดึงข้อมูล (Poll Interval) และขา GPIO Allowlist ผ่านหน้าเว็บแอดมิน
  - **WiFi Fail-Safe Rollback:** เมื่อสั่งเปลี่ยนชื่อ Wi-Fi ใหม่ หากบอร์ดต่อเน็ตไม่ได้ภายใน 60 วินาที จะดีดตัวกลับมาใช้ Wi-Fi เดิมอัตโนมัติ ตู้จะไม่หลุดการติดต่อ
  - **Pull OTA Firmware Update:** รองรับการอัปเดตเฟิร์มแวร์ผ่าน HTTPS จาก Firebase Storage พร้อมตรวจสอบความถูกต้องของไฟล์ด้วย SHA-256 Checksum และมีระบบ 2-Slot Partition Rollback คืนค่าเดิมทันทีหากโค้ดใหม่ไม่ทำงาน

---

# ส่วนที่ 3: รายละเอียดทั้งหมดและการทำงานของระบบ (Full System Specifications)

### 3.1 โฟลว์การทำงานแบบครบวงจร (End-to-End Operational Flow)

```text
[ ผู้ใช้งาน / ลูกค้า ]              [ Kiosk Web ]               [ Backend Server ]          [ บอร์ด ESP32 ]
         |                                |                             |                         |
         |--- 1. เลือกพอร์ต & จำนวนเงิน --->|                             |                         |
         |<-- 2. แสดง QR พร้อมเพย์ / วอเลท --|                             |                         |
         |--- 3. สแกนจ่ายเงิน & แนบสลิป --->|                             |                         |
         |                                |-- 4. ส่งสลิปไปตรวจสอบ -------->|                         |
         |                                |                             |-- 5. ตรวจผ่าน EasySlip -|
         |                                |                             |-- 6. ป้องกันสลิปซ้ำ ---|
         |                                |<-- 7. ส่งผลยืนยันสำเร็จ -------|                         |
         |<-- 8. เสียงพูด & เริ่มนับเวลา -----|                             |                         |
         |                                |                             |<-- 9. Poll คำสั่งรีเลย์ ---|
         |                                |                             |--- 10. สั่งเปิดไฟชาร์จ --->|
         |                                |                             |                         |== จ่ายไฟ 5V ==
         |                                |                             |                         |
         |--- 11. (ถ้ามี) กดหยุดชาร์จก่อนเวลา ->|                             |                         |
         |                                |-- 12. ส่งคำสั่งตัดไฟก่อนเวลา -->|                         |
         |                                |                             |<-- 13. รับคำสั่งตัดไฟ ----|
         |<-- 14. แจ้งเตือนถอดสายชาร์จ ------|                             |                         |== ตัดกระแสไฟ ==
```

---

### 3.2 โครงสร้างไฟล์และโฟลเดอร์ของโปรเจกต์ (Project Structure)

```text
usb-charger-master/
├── public/                       # ไฟล์ Frontend ทั้งหมด (Deploy บน Firebase Hosting)
│   ├── index.html                # หน้าเว็บตู้ชาร์จหลัก (Kiosk Interface)
│   ├── admin.html                # หน้าเว็บศูนย์ควบคุมผู้ดูแลระบบ (Admin Dashboard)
│   ├── config.js                 # ค่าคอนฟิกเริ่มต้นของฝั่ง Client
│   ├── manifest.json             # PWA Manifest สำหรับติดตั้งเว็บแอป
│   └── assets/                   # ไฟล์รูปภาพ ไอคอน โลโก้ และไลบรารีสคริปต์
│       ├── qrcode.min.js         # ตัวสร้างภาพ QR Code
│       └── ... (ไอคอนและรูปภาพประกอบ)
├── esp32-demo/                   # ซอร์สโค้ด Arduino สำหรับบอร์ด ESP32
│   └── esp32-demo.ino            # เฟิร์มแวร์หลักของ ESP32 (WiFi, Relays, Heartbeat, OTA)
├── charging-server.js            # โค้ด Backend หลัก (Node.js + Express + Firebase Admin)
├── server.js                     # Entry point เริ่มต้นสำหรับเรียก charging-server.js
├── firestore.rules               # กฎความปลอดภัยของฐานข้อมูล Cloud Firestore
├── firebase.json                 # ไฟล์ตั้งค่า Firebase Hosting, Clean URLs, และ Routing
├── .firebaserc                   # กำหนดชื่อโปรเจกต์ Firebase (usb-charger-project)
├── package.json                  # รายการ Dependencies ของ Node.js
├── WIRING.md                     # แผนผังการต่อสายวงจรอย่างละเอียด
├── PROJECT_MEMORY.md             # เอกสารสถาปัตยกรรมและประวัติการพัฒนา
└── README.md                     # เอกสารแนะนำโครงการฉบับสมบูรณ์ (ไฟล์นี้)
```

---

### 3.3 การติดตั้งและตั้งค่าระบบ (Setup & Deployment Guide)

#### 1. การรันเซิร์ฟเวอร์จำลองในเครื่อง (Local Development)
```bash
# ติดตั้งไลบรารีที่จำเป็น
npm install

# รันเซิร์ฟเวอร์ Backend
node server.js
```
*เปิดเบราว์เซอร์ไปที่ `http://localhost:3000` เพื่อทดสอบหน้าตู้ หรือ `http://localhost:3000/admin` เพื่อเข้าหน้าผู้ดูแล*

#### 2. การ Deploy ขึ้น Firebase Hosting & Firestore
```bash
# เข้าสู่ระบบ Firebase CLI
firebase login

# สั่ง Deploy เว็บไซต์และกฎความปลอดภัยขึ้น Cloud
firebase deploy --only hosting,firestore:rules
```

#### 3. การอัปโหลดโค้ดลงบอร์ด ESP32
1. เปิดโปรแกรม **Arduino IDE**
2. ติดตั้งบอร์ดเสริม **ESP32 by Espressif Systems** (เวอร์ชัน 2.0.x ขึ้นไป)
3. ไปที่ `Tools` > `Board` > เลือก **DOIT ESP32 DEVKIT V1**
4. เปิดไฟล์ [esp32-demo/esp32-demo.ino](file:///C:/Users/ROOM_A/.gemini/antigravity/scratch/usb-charger-master/esp32-demo/esp32-demo.ino)
5. แก้ไขชื่อและรหัสผ่าน Wi-Fi เริ่มต้นในส่วน `WIFI_SSID` และ `WIFI_PASSWORD`
6. เสียบสาย USB เข้ากับคอมพิวเตอร์ เลือกพอร์ต COM ให้ถูกต้อง แล้วกดปุ่ม **Upload**

---

### 3.4 รายการตัวแปรสภาพแวดล้อม (Environment Variables)

ตั้งค่าใน Dashboard ของ Render Cloud เพื่อให้ระบบทำงานเต็มรูปแบบ:

| ตัวแปร | ความจำเป็น | คำอธิบาย |
|---|---|---|
| `PORT` | แนะนำ | พอร์ตของเซิร์ฟเวอร์ (ค่าเริ่มต้น: `3000` หรือกำหนดโดย Render) |
| `PROMPTPAY_PHONE` | สำคัญ | เบอร์โทรศัพท์หรือเลขบัตรประชาชนที่ผูกพร้อมเพย์รับเงิน |
| `TRUEMONEY_PHONE` | สำคัญ | เบอร์โทรศัพท์ TrueMoney Wallet สำหรับรับซองอั่งเปา |
| `SECONDS_PER_BAHT` | แนะนำ | อัตราค่าบริการ (เช่น `180` = 1 บาทได้ชาร์จ 180 วินาที หรือ 3 นาที) |
| `EASYSLIP_API_KEY` | สำคัญ | API Key จาก EasySlip เพื่อใช้ตรวจสลิปธนาคารอัตโนมัติ |
| `ESP32_SECRET` | แนะนำ | รหัสผ่าน Shared Secret ระหว่างเซิร์ฟเวอร์กับบอร์ด ESP32 |
| `ADMIN_EMAILS` | สำคัญ | อีเมล Google ของแอดมิน คั่นด้วยเครื่องหมายจุลภาค (,) |
| `FIREBASE_PROJECT_ID`| ทั่วไป | รหัสโปรเจกต์ Firebase (`usb-charger-project`) |
| `FIREBASE_SERVICE_ACCOUNT`| แนะนำ | เนื้อหาไฟล์ Service Account JSON สำหรับให้ Render ซิงก์ Firestore |

---

> **หมายเหตุ:** โครงการนี้พัฒนาขึ้นเพื่อการศึกษาและการประยุกต์ใช้งานจริง ห้ามนำข้อมูลความลับส่วนบุคคลหรือรหัสผ่านไปเผยแพร่ในที่สาธารณะตามนโยบายความปลอดภัย Zero PIN Policy ของระบบ
