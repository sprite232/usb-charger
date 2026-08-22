# Smart Charger ESP32 Wiring

ตัวอย่างนี้ใช้ ESP32 DevKit V1 แบบ 30 pin เป็นหลัก ถ้าบอร์ดคนละรุ่นให้ดูชื่อ GPIO บนบอร์ดเป็นหลัก ไม่ต้องดูตำแหน่งขา

## สรุป Pin ที่แนะนำ

| อุปกรณ์ | ขาอุปกรณ์ | ต่อกับ ESP32 | หมายเหตุ |
|---|---:|---:|---|
| Relay Module | IN | GPIO26 | สั่งเปิด/ปิดไฟ USB |
| Relay Module | VCC | 5V | ใช้รีเลย์ 5V |
| Relay Module | GND | GND | ต้องกราวด์ร่วมกับ ESP32 |
| Coin Sensor 5 บาท | Signal | GPIO32 | ใช้ `INPUT_PULLUP` |
| Coin Sensor 10 บาท | Signal | GPIO33 | ใช้ `INPUT_PULLUP` |
| Coin Sensors | VCC | 3.3V/5V | ขึ้นกับโมดูล |
| Coin Sensors | GND | GND | กราวด์ร่วม |
| Color Sensor TCS3200 | S0 | GPIO14 | ตั้ง scale ความถี่ |
| Color Sensor TCS3200 | S1 | GPIO27 | ตั้ง scale ความถี่ |
| Color Sensor TCS3200 | S2 | GPIO25 | เลือก filter สี |
| Color Sensor TCS3200 | S3 | GPIO13 | เลือก filter สี |
| Color Sensor TCS3200 | OUT | GPIO34 | input only เหมาะอ่านสัญญาณ |
| Color Sensor TCS3200 | VCC | 3.3V | ปลอดภัยกับ ESP32 |
| Color Sensor TCS3200 | GND | GND | กราวด์ร่วม |
| Current Sensor ACS712 | OUT | GPIO35 | อ่าน analog กระแส |
| Current Sensor ACS712 | VCC | 5V | ACS712 ส่วนมากใช้ 5V |
| Current Sensor ACS712 | GND | GND | กราวด์ร่วม |
| TFT SPI | VCC | 3.3V | อย่าต่อ 5V ถ้าจอไม่รองรับ |
| TFT SPI | GND | GND | กราวด์ร่วม |
| TFT SPI | SCK/SCL | GPIO18 | SPI clock |
| TFT SPI | SDA/MOSI | GPIO23 | SPI MOSI |
| TFT SPI | CS | GPIO5 | chip select |
| TFT SPI | DC/A0 | GPIO2 | data/command |
| TFT SPI | RST | GPIO4 | reset |
| TFT SPI | LED/BL | 3.3V | ไฟ backlight |
| Button QR Confirm | ขาหนึ่ง | GPIO21 | ใช้ `INPUT_PULLUP` |
| Button QR Confirm | อีกขา | GND | กดแล้วค่าเป็น LOW |
| Button Reset/Cancel | ขาหนึ่ง | GPIO22 | ใช้ `INPUT_PULLUP` |
| Button Reset/Cancel | อีกขา | GND | กดแล้วค่าเป็น LOW |

## แนวคิดการต่อไฟชาร์จผ่านรีเลย์

ใช้รีเลย์ตัด/ต่อไฟฝั่ง 5V ที่จะไปพอร์ต USB:

```text
Adapter 5V+  -> Relay COM
Relay NO     -> USB VBUS 5V+
Adapter GND  -> USB GND
```

เมื่อ ESP32 สั่ง `RELAY_PIN = HIGH` รีเลย์จะต่อไฟ 5V ไปที่ USB แล้วโทรศัพท์เริ่มชาร์จ

## ข้อควรระวัง

- GND ของ ESP32, รีเลย์, เซนเซอร์, อะแดปเตอร์ 5V ควรร่วมกันถ้าอ่านสัญญาณร่วมกัน
- GPIO34 และ GPIO35 เป็น input only ใช้อ่านเซนเซอร์ได้ แต่สั่ง output ไม่ได้
- ESP32 รับสัญญาณ 3.3V เป็นหลัก ถ้าโมดูลใดปล่อยสัญญาณ 5V เข้าขา GPIO ให้ใส่ตัวแบ่งแรงดันหรือ level shifter
- ACS712 ใช้ 5V และ output กลางประมาณ 2.5V ยังพออ่านด้วย ESP32 ได้ในหลายกรณี แต่ควรวัดจริงก่อน ถ้า output เกิน 3.3V ต้องลดแรงดัน
- งานจริงกับไฟบ้าน 220V ไม่ควรต่อเอง ให้ใช้เฉพาะฝั่ง 5V USB เพื่อความปลอดภัย

## Flow การทำงานกับเว็บ

```text
Website -> Server: สร้าง QR / ยืนยันโอน / จำลองเงินสด
Server  -> ESP32: /api/esp32/command บอก relayOn และเวลาคงเหลือ
ESP32   -> Relay: เปิดไฟ USB
ESP32   -> Server: /api/esp32/report ถ้าแบตเต็ม
Website -> Server: /api/state แสดงสถานะตู้
```
