/*
  🔌 ESP32 Smart USB Charger Controller (4 Ports)
  
  GPIO Pin Mapping:
  - Port 1: USB-A 1 -> GPIO 26 (Relay 1)
  - Port 2: USB-A 2 -> GPIO 27 (Relay 2)
  - Port 3: USB-C 1 -> GPIO 25 (Relay 3)
  - Port 4: USB-C 2 -> GPIO 33 (Relay 4)
  
  Flow:
  1. ESP32 connects to WiFi.
  2. Polls /api/esp32/command every 2 seconds.
  3. Updates GPIO 26, 27, 25, 33 according to relayOn state.
  4. Reports hardware heartbeat to /api/esp32/report.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define SERVER_URL "http://192.168.1.50:3000" // IP ของเครื่องคอมพิวเตอร์/เซิร์ฟเวอร์

// 4 Relays Pins
const int RELAY_PINS[4] = { 26, 27, 25, 33 };
const char* PORT_KEYS[4] = { "usb-a-1", "usb-a-2", "usb-c-1", "usb-c-2" };

void setup() {
  Serial.begin(115200);
  
  // Setup Relay Pins
  for (int i = 0; i < 4; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], LOW); // ปิดไฟเริ่มต้น (Active-High)
  }

  Serial.println("\n🔌 Starting Smart USB Charger ESP32...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n✅ WiFi Connected! IP: " + WiFi.localIP().toString());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    fetchRelayCommands();
  } else {
    Serial.println("⚠️ WiFi Disconnected, reconnecting...");
    WiFi.reconnect();
  }
  delay(2000); // ตรวจสอบสถานะทุกๆ 2 วินาที
}

void fetchRelayCommands() {
  HTTPClient http;
  http.begin(String(SERVER_URL) + "/api/esp32/command");
  http.setTimeout(3000);
  
  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    StaticJsonDocument<1024> doc;
    DeserializationError error = deserializeJson(doc, payload);

    if (!error && doc.containsKey("relays")) {
      JsonObject relays = doc["relays"];
      
      for (int i = 0; i < 4; i++) {
        const char* key = PORT_KEYS[i];
        if (relays.containsKey(key)) {
          bool isOn = relays[key]["on"] | false;
          int gpio = RELAY_PINS[i];
          
          // สั่ง Relay (HIGH = เปิดไฟ, LOW = ปิดไฟ)
          digitalWrite(gpio, isOn ? HIGH : LOW);
        }
      }
    }
  } else {
    Serial.printf("❌ HTTP Error: %d\n", httpCode);
  }
  http.end();
}
