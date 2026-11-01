/*
  🔌 ESP32 Smart USB Charger Controller (4 Ports)
  
  GPIO Pin Mapping:
  - Port 1: USB-A 1 -> GPIO 26 (Relay 1)
  - Port 2: USB-A 2 -> GPIO 27 (Relay 2)
  - Port 3: USB-C 1 -> GPIO 25 (Relay 3)
  - Port 4: USB-C 2 -> GPIO 33 (Relay 4)
  
  Flow:
  1. ESP32 connects to WiFi (2.4GHz).
  2. Polls /api/esp32/command every 2 seconds.
  3. Updates GPIO 26, 27, 25, 33 according to relayOn state.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

#define WIFI_SSID "Palm_tawan_2.4G"
#define WIFI_PASSWORD "0626097440"
#define SERVER_URL "http://192.168.1.107:3000" // IP คอมพิวเตอร์เซิร์ฟเวอร์
#define ESP32_SECRET "usb-charger-esp32-hw-secret-key-2026" // Hardware Secret Token

// 4 Relays Pins
const int RELAY_PINS[4] = { 26, 27, 25, 33 };
const char* PORT_KEYS[4] = { "usb-a-1", "usb-a-2", "usb-c-1", "usb-c-2" };

// Relay State Cache
bool currentRelayState[4] = { false, false, false, false };
int pollCount = 0;

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  // Setup Relay Pins
  for (int i = 0; i < 4; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], LOW); // ปิดไฟเริ่มต้น (Active-High Relay: LOW = OFF, HIGH = ON)
  }

  Serial.println("\n==========================================");
  Serial.println("🔌 Starting Smart USB Charger ESP32...");
  Serial.printf("📡 Connecting to WiFi: %s\n", WIFI_SSID);
  Serial.println("==========================================");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Connected Successfully!");
    Serial.println("📍 ESP32 IP: " + WiFi.localIP().toString());
    Serial.printf("🎯 Target Server: %s\n", SERVER_URL);
    Serial.println("📡 เริ่มต้นรับคำสั่งจากเซิร์ฟเวอร์...");
  } else {
    Serial.printf("\n⚠️ ยังเชื่อมต่อ WiFi ไม่สำเร็จ (Status Code: %d)\n", WiFi.status());
    Serial.println("   ระบบจะพยายามเชื่อมต่อใหม่อัตโนมัติใน loop...");
  }
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    fetchRelayCommands();
  } else {
    Serial.println("⚠️ กำลังเชื่อมต่อ WiFi อีกครั้ง...");
    WiFi.disconnect();
    WiFi.reconnect();
    delay(3000);
  }
  delay(2000); // Poll ทุก 2 วินาที
}

void fetchRelayCommands() {
  HTTPClient http;
  String url = String(SERVER_URL) + "/api/esp32/command?secret=" + ESP32_SECRET;
  http.begin(url);
  http.setTimeout(4000);
  http.addHeader("X-ESP32-Secret", ESP32_SECRET);
  
  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    #if ARDUINOJSON_VERSION_MAJOR >= 7
    JsonDocument doc;
    #else
    StaticJsonDocument<1024> doc;
    #endif
    DeserializationError error = deserializeJson(doc, payload);

    if (!error && !doc["relays"].isNull()) {
      JsonObject relays = doc["relays"].as<JsonObject>();
      
      for (int i = 0; i < 4; i++) {
        const char* key = PORT_KEYS[i];
        if (!relays[key].isNull()) {
          bool isOn = relays[key]["on"] | false;
          int gpio = RELAY_PINS[i];
          
          // ตรวจสอบว่ามีการเปลี่ยนสถานะหรือไม่
          if (isOn != currentRelayState[i]) {
            currentRelayState[i] = isOn;
            digitalWrite(gpio, isOn ? HIGH : LOW);
            Serial.printf("⚡ [คำสั่ง Relay] พอร์ต %d (%s | GPIO %d) -> %s\n", 
                          i + 1, key, gpio, isOn ? "🟢 เปิดไฟ (ON)" : "🔴 ปิดไฟ (OFF)");
          }
        }
      }

      // แสดง Heartbeat ทุกๆ 10 วินาที (5 รอบการ poll)
      pollCount++;
      if (pollCount >= 5) {
        pollCount = 0;
        Serial.printf("📡 [Sync OK] สถานะรีเลย์: P1=%s | P2=%s | P3=%s | P4=%s\n",
                      currentRelayState[0] ? "ON" : "OFF",
                      currentRelayState[1] ? "ON" : "OFF",
                      currentRelayState[2] ? "ON" : "OFF",
                      currentRelayState[3] ? "ON" : "OFF");
      }
    }
  } else if (httpCode > 0) {
    Serial.printf("❌ HTTP Error จากเซิร์ฟเวอร์: %d\n", httpCode);
  } else {
    Serial.printf("❌ ไม่สามารถติดต่อเซิร์ฟเวอร์ได้ (%s) — ตรวจสอบว่าเปิด 'node server.js' หรือยัง\n", http.errorToString(httpCode).c_str());
  }
  http.end();
}
