/*
  🔌 ESP32 Smart USB Charger Controller (4 Ports) with Smart Wi-Fi Captive Portal
  
  GPIO Pin Mapping:
  - Port 1: USB-A 1 -> GPIO 26 (Relay 1)
  - Port 2: USB-A 2 -> GPIO 27 (Relay 2)
  - Port 3: USB-C 1 -> GPIO 25 (Relay 3)
  - Port 4: USB-C 2 -> GPIO 33 (Relay 4)
  - Reset / Config Button: GPIO 0 (BOOT Button on board)

  Features:
  1. Smart Wi-Fi & Captive Portal:
     - Saves Wi-Fi credentials in Flash memory (Preferences).
     - If unable to connect within 15 seconds, broadcasts Hotspot "SmartCharger-Setup" (pass: admin1234).
     - Captive Portal at 192.168.4.1 opens automatically on smartphone to select Wi-Fi and save without computer.
     - Hold BOOT button (GPIO 0) for 3 seconds anytime to force setup mode.
  2. Cloud Sync:
     - Polls /api/esp32/command every 2 seconds via HTTPS.
     - Controls 4 relays with active-high logic.
     - Reports local IP, RSSI signal, and heartbeat.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>

// Default Fallbacks
#define DEFAULT_SSID "Palm_tawan_2.4G"
#define DEFAULT_PASS "0626097440"
#define DEFAULT_SERVER "https://usb-charger.onrender.com"
#define ESP32_SECRET "usb-charger-esp32-hw-secret-key-2026"

// SoftAP Config
#define AP_SSID "SmartCharger-Setup"
#define AP_PASS "admin1234"
#define BOOT_PIN 0

// 4 Relays Pins
const int RELAY_PINS[4] = { 26, 27, 25, 33 };
const char* PORT_KEYS[4] = { "usb-a-1", "usb-a-2", "usb-c-1", "usb-c-2" };

// Global Objects
Preferences prefs;
WebServer server(80);
DNSServer dnsServer;

// Runtime Variables
String currentSSID = DEFAULT_SSID;
String currentPass = DEFAULT_PASS;
String currentServer = DEFAULT_SERVER;
bool isApMode = false;
bool currentRelayState[4] = { false, false, false, false };
int pollCount = 0;
bool isFirstConnect = true;
unsigned long bootPressStart = 0;
unsigned long lastDisconnectTime = 0;

void fetchRelayCommands();
void startConfigPortal();
void handleRoot();
void handleSave();
void handleNotFound();

void setup() {
  Serial.begin(115200);
  delay(1000);

  // Setup Button
  pinMode(BOOT_PIN, INPUT_PULLUP);

  // Setup Relay Pins
  for (int i = 0; i < 4; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], LOW); // ปิดไฟเริ่มต้น (Active-High: LOW = OFF, HIGH = ON)
  }

  // Read saved settings
  prefs.begin("charger", false);
  currentSSID = prefs.getString("ssid", DEFAULT_SSID);
  currentPass = prefs.getString("pass", DEFAULT_PASS);
  currentServer = prefs.getString("server", DEFAULT_SERVER);
  prefs.end();

  Serial.println("\n==========================================");
  Serial.println("🔌 Smart USB Charger ESP32 starting...");
  Serial.printf("📡 Target WiFi: %s\n", currentSSID.c_str());
  Serial.printf("🎯 Target Server: %s\n", currentServer.c_str());
  Serial.println("💡 กดปุ่ม BOOT ค้าง 3 วินาที เพื่อปล่อย Hotspot ตั้งค่า");
  Serial.println("==========================================");

  // Check if BOOT pressed during startup
  if (digitalRead(BOOT_PIN) == LOW) {
    delay(500);
    if (digitalRead(BOOT_PIN) == LOW) {
      Serial.println("🔘 ตรวจพบการกดปุ่ม BOOT — เข้าสู่โหมดปล่อย Hotspot ทันที");
      startConfigPortal();
      return;
    }
  }

  // Try connecting to STA WiFi
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  WiFi.begin(currentSSID.c_str(), currentPass.c_str());

  int attempts = 0;
  Serial.print("⏳ กำลังเชื่อมต่อ Wi-Fi");
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Connected Successfully!");
    Serial.println("📍 ESP32 Local IP: " + WiFi.localIP().toString());
    Serial.printf("🎯 Target Server: %s\n", currentServer.c_str());
    Serial.println("📡 เริ่มต้นรับคำสั่งจากเซิร์ฟเวอร์...");
  } else {
    Serial.printf("\n⚠️ ไม่สามารถเชื่อมต่อ Wi-Fi '%s' ได้ (Status: %d)\n", currentSSID.c_str(), WiFi.status());
    Serial.println("🔄 กำลังเปิดระบบ Smart Wi-Fi Hotspot ให้ตั้งค่าผ่านมือถือ...");
    startConfigPortal();
  }
}

void loop() {
  // Check BOOT button (GPIO 0)
  if (digitalRead(BOOT_PIN) == LOW) {
    if (bootPressStart == 0) bootPressStart = millis();
    else if (millis() - bootPressStart > 3000) {
      Serial.println("\n🔘 กดปุ่ม BOOT ค้าง 3 วินาที -> เปิด Hotspot ตั้งค่า Wi-Fi ใหม่");
      startConfigPortal();
      bootPressStart = 0;
      delay(1000);
    }
  } else {
    bootPressStart = 0;
  }

  // AP Mode Execution
  if (isApMode) {
    dnsServer.processNextRequest();
    server.handleClient();
    delay(10);
    return;
  }

  // Normal Connected Execution
  if (WiFi.status() == WL_CONNECTED) {
    lastDisconnectTime = 0;
    fetchRelayCommands();
    delay(2000);
  } else {
    if (lastDisconnectTime == 0) lastDisconnectTime = millis();
    
    // If disconnected for more than 45 seconds, start AP setup mode
    if (millis() - lastDisconnectTime > 45000) {
      Serial.println("\n⚠️ สัญญาณ Wi-Fi ขาดหายเกิน 45 วินาที -> สลับเข้าสู่ Hotspot ให้ตั้งค่าอัตโนมัติ");
      startConfigPortal();
      return;
    }

    Serial.printf("⚠️ Wi-Fi ขาดการเชื่อมต่อ (สถานะ: %d) กำลังลองใหม่...\n", WiFi.status());
    WiFi.reconnect();
    delay(3000);
  }
}

// ----------------------------------------------------
// 🌐 Smart Wi-Fi Hotspot & Captive Portal
// ----------------------------------------------------
void startConfigPortal() {
  isApMode = true;
  WiFi.disconnect();
  delay(100);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASS);
  delay(200);

  IPAddress apIP = WiFi.softAPIP();
  Serial.println("\n==========================================");
  Serial.println("📶 [เปิดระบบ Smart Wi-Fi Hotspot สำเร็จ]");
  Serial.printf("📲 เชื่อมต่อ Wi-Fi ชื่อ: %s\n", AP_SSID);
  Serial.printf("🔑 รหัสผ่าน Wi-Fi: %s\n", AP_PASS);
  Serial.printf("🌐 เข้าหน้าตั้งค่าที่: http://%s\n", apIP.toString().c_str());
  Serial.println("==========================================");

  // DNS Server for Captive Portal (redirect all requests to AP IP)
  dnsServer.start(53, "*", apIP);

  // WebServer routes
  server.on("/", handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/generate_204", handleRoot); // Android captive portal
  server.on("/hotspot-detect.html", handleRoot); // Apple captive portal
  server.onNotFound(handleNotFound);
  server.begin();
}

void handleRoot() {
  int n = WiFi.scanNetworks();
  String options = "";
  for (int i = 0; i < n; ++i) {
    String ssidName = WiFi.SSID(i);
    if (ssidName.length() > 0) {
      int rssi = WiFi.RSSI(i);
      String selected = (ssidName == currentSSID) ? "selected" : "";
      options += "<option value='" + ssidName + "' " + selected + ">" + ssidName + " (" + String(rssi) + " dBm)</option>";
    }
  }

  String html = R"rawliteral(
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ตั้งค่า Wi-Fi ตู้ชาร์จ</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0f172a; color: #f8fafc; padding: 20px; display: flex; justify-content: center; }
    .card { background: #1e293b; border-radius: 16px; padding: 24px; max-width: 420px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; }
    .header { text-align: center; margin-bottom: 20px; }
    .icon { font-size: 40px; margin-bottom: 8px; }
    h2 { font-size: 20px; color: #38bdf8; }
    p { font-size: 13px; color: #94a3b8; margin-top: 4px; }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #cbd5e1; }
    select, input { width: 100%; padding: 12px; background: #0f172a; border: 1.5px solid #475569; border-radius: 10px; color: #fff; font-size: 14px; outline: none; }
    select:focus, input:focus { border-color: #38bdf8; }
    .btn { width: 100%; padding: 14px; background: linear-gradient(135deg, #0284c7, #0369a1); border: none; border-radius: 10px; color: #fff; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 8px; }
    .btn:active { transform: scale(0.98); }
    .footer { text-align: center; font-size: 12px; color: #64748b; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="icon">🔌⚡</div>
      <h2>Smart USB Charger</h2>
      <p>ตั้งค่า Wi-Fi เพื่อให้ตู้ชาร์จเชื่อมต่อระบบออนไลน์</p>
    </div>
    <form action="/save" method="POST">
      <div class="form-group">
        <label>📡 เลือก Wi-Fi (2.4GHz):</label>
        <select name="ssid" id="ssidSelect">
  )rawliteral";

  html += options;
  html += R"rawliteral(
        </select>
      </div>
      <div class="form-group">
        <label>✏️ หรือพิมพ์ชื่อ Wi-Fi เอง:</label>
        <input type="text" name="custom_ssid" placeholder="กรอกกรณี Wi-Fi ซ่อนชื่อ">
      </div>
      <div class="form-group">
        <label>🔑 รหัสผ่าน Wi-Fi:</label>
        <input type="password" name="password" placeholder="รหัสผ่าน Wi-Fi" required>
      </div>
      <div class="form-group">
        <label>🎯 เซิร์ฟเวอร์ตู้ชาร์จ (Server URL):</label>
        <input type="text" name="server" value=")rawliteral";
  html += currentServer;
  html += R"rawliteral(">
      </div>
      <button type="submit" class="btn">💾 บันทึกและเชื่อมต่อทันที</button>
    </form>
    <div class="footer">
      ฮอตสปอตตู้ชาร์จ: SmartCharger-Setup (IP: 192.168.4.1)
    </div>
  </div>
</body>
</html>
  )rawliteral";

  server.send(200, "text/html", html);
}

void handleSave() {
  String reqSSID = server.arg("custom_ssid");
  if (reqSSID.length() == 0) {
    reqSSID = server.arg("ssid");
  }
  String reqPass = server.arg("password");
  String reqServer = server.arg("server");
  if (reqServer.length() == 0) reqServer = DEFAULT_SERVER;

  if (reqSSID.length() > 0) {
    prefs.begin("charger", false);
    prefs.putString("ssid", reqSSID);
    prefs.putString("pass", reqPass);
    prefs.putString("server", reqServer);
    prefs.end();

    String reply = R"rawliteral(
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>บันทึกสำเร็จ</title>
  <style>
    body { background: #0f172a; color: #fff; font-family: sans-serif; text-align: center; padding: 40px 20px; }
    .box { background: #1e293b; border-radius: 16px; padding: 30px; max-width: 400px; margin: 0 auto; border: 1px solid #334155; }
    h2 { color: #4ade80; margin-bottom: 12px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="box">
    <h2>✅ บันทึกสำเร็จ!</h2>
    <p>ESP32 กำลังรีสตาร์ทเพื่อเชื่อมต่อ Wi-Fi: <strong>)rawliteral";
    reply += reqSSID;
    reply += R"rawliteral(</strong></p>
    <p style="margin-top:16px;">บอร์ดจะเชื่อมต่อไปยังตู้ชาร์จและเริ่มทำงานทันที</p>
  </div>
</body>
</html>
    )rawliteral";
    server.send(200, "text/html", reply);
    delay(2000);
    ESP.restart();
  } else {
    server.send(400, "text/plain", "กรุณาระบุชื่อ Wi-Fi");
  }
}

void handleNotFound() {
  // Captive Portal redirect
  server.sendHeader("Location", "http://192.168.4.1/", true);
  server.send(302, "text/plain", "");
}

// ----------------------------------------------------
// ⚡ Relay Commands Fetcher from Cloud Server
// ----------------------------------------------------
void fetchRelayCommands() {
  HTTPClient http;
  String myIp = WiFi.localIP().toString();
  long rssi = WiFi.RSSI();
  String url = currentServer + "/api/esp32/command?secret=" + ESP32_SECRET + "&ip=" + myIp + "&rssi=" + String(rssi);
  
  WiFiClientSecure secClient;
  if (url.startsWith("https://")) {
    secClient.setInsecure(); // SSL Insecure bypass for Cloud domains
    secClient.setTimeout(15000);
    http.begin(secClient, url);
  } else {
    http.begin(url);
  }
  http.setTimeout(15000);
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
          
          if (isOn != currentRelayState[i]) {
            currentRelayState[i] = isOn;
            digitalWrite(gpio, isOn ? HIGH : LOW);
            Serial.printf("⚡ [คำสั่งจากเซิร์ฟเวอร์] พอร์ต %d (%s | GPIO %d) -> %s\n", 
                          i + 1, key, gpio, isOn ? "🟢 เปิดไฟ (ON)" : "🔴 ปิดไฟ (OFF)");
          }
        }
      }

      if (isFirstConnect) {
        isFirstConnect = false;
        Serial.println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        Serial.printf("🟢 [เชื่อมต่อกับเว็บและเซิร์ฟเวอร์สำเร็จแล้ว!]\n");
        Serial.printf("📍 IP ตัวเอง: %s\n", myIp.c_str());
        Serial.printf("🎯 เซิร์ฟเวอร์: %s\n", currentServer.c_str());
        Serial.println("✨ ระบบพร้อมควบคุมและแสดงสถานะบนหน้าเว็บได้ทันที");
        Serial.println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      }

      pollCount++;
      if (pollCount >= 5) {
        pollCount = 0;
        Serial.printf("📡 [Sync OK] สถานะรีเลย์: P1=%s | P2=%s | P3=%s | P4=%s (WiFi: %ld dBm)\n",
                      currentRelayState[0] ? "ON" : "OFF",
                      currentRelayState[1] ? "ON" : "OFF",
                      currentRelayState[2] ? "ON" : "OFF",
                      currentRelayState[3] ? "ON" : "OFF",
                      rssi);
      }
    }
  } else if (httpCode > 0) {
    Serial.printf("❌ HTTP Code จากเซิร์ฟเวอร์: %d\n", httpCode);
  } else {
    Serial.printf("❌ ไม่สามารถติดต่อเซิร์ฟเวอร์ได้ (%s)\n", http.errorToString(httpCode).c_str());
  }
  http.end();
}
