/*
  ESP32 Smart USB Charger Controller (4 Ports) with Smart Wi-Fi Captive Portal

  GPIO Pin Mapping:
  - Port 1: USB-A 1 -> GPIO 26 (Relay 1)
  - Port 2: USB-A 2 -> GPIO 27 (Relay 2)
  - Port 3: USB-C 1 -> GPIO 25 (Relay 3)
  - Port 4: USB-C 2 -> GPIO 33 (Relay 4)
  - Reset / Config Button: GPIO 0 (BOOT Button on board)

  Features:
  1. Hardware Fail-Safe:
     - Initializes all 4 relay pins LOW immediately on boot before Wi-Fi starts.
     - Tracks local millis() remaining charge timer per port and shuts relay OFF automatically if Wi-Fi drops.
  2. Smart Wi-Fi & Captive Portal:
     - Saves Wi-Fi credentials, Server URL, and ESP32_SECRET in Flash memory (Preferences).
     - Broadcasts SoftAP "SmartCharger-Setup" (default setup passphrase configured in Captive Portal / placeholder constant) when Wi-Fi fails or BOOT button is held 3s.
     - Captive Portal at 192.168.4.1 opens on smartphone for setup without reflashing.
  3. Cloud Sync:
     - Polls /api/esp32/command every 2 seconds via HTTPS using X-ESP32-Secret header only.
     - Reports local IP, RSSI signal, and active port heartbeat.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>

// Default Placeholders (Override via Captive Portal at 192.168.4.1 — do NOT commit real credentials)
#define DEFAULT_SSID "YOUR_WIFI_SSID"
#define DEFAULT_PASS "YOUR_WIFI_PASSWORD"
#define DEFAULT_SERVER "https://usb-charger.onrender.com"
#define DEFAULT_ESP32_SECRET "CHANGE_ME_ESP32_SECRET"

// SoftAP Config (Change AP passphrase before deploying hardware)
#define AP_SSID "SmartCharger-Setup"
#define AP_PASS "CHANGE_ME_AP_PASS"
#define BOOT_PIN 0

// 4 Relay Pins (Active-High: LOW = OFF, HIGH = ON)
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
String currentSecret = DEFAULT_ESP32_SECRET;

bool isApMode = false;
bool currentRelayState[4] = { false, false, false, false };
bool portPausedState[4] = { false, false, false, false };
unsigned long portRemainingMs[4] = { 0, 0, 0, 0 };
unsigned long portLastSyncMs[4] = { 0, 0, 0, 0 };

int pollCount = 0;
bool isFirstConnect = true;
unsigned long bootPressStart = 0;
unsigned long lastDisconnectTime = 0;
unsigned long lastPollMs = 0;

void fetchRelayCommands();
void enforceLocalFailsafe();
void startConfigPortal();
void handleRoot();
void handleSave();
void handleNotFound();
String htmlEscape(const String& src);

String htmlEscape(const String& src) {
  String out = src;
  out.replace("&", "&amp;");
  out.replace("<", "&lt;");
  out.replace(">", "&gt;");
  out.replace("\"", "&quot;");
  out.replace("'", "&#39;");
  return out;
}

void setRelayHardware(int idx, bool turnOn, const char* reasonTag) {
  if (idx < 0 || idx >= 4) return;
  if (currentRelayState[idx] != turnOn) {
    currentRelayState[idx] = turnOn;
    digitalWrite(RELAY_PINS[idx], turnOn ? HIGH : LOW);
    Serial.printf("[RELAY] Port %d (%s | GPIO %d) -> %s (%s)\n",
                  idx + 1, PORT_KEYS[idx], RELAY_PINS[idx],
                  turnOn ? "ON" : "OFF", reasonTag);
  }
}

void setup() {
  // 1. Hardware Fail-Safe FIRST: force all relay pins OFF before anything else initializes
  for (int i = 0; i < 4; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], LOW);
    currentRelayState[i] = false;
  }

  pinMode(BOOT_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  delay(500);

  // 2. Load saved credentials & server secret from NVS Flash
  prefs.begin("charger", false);
  currentSSID = prefs.getString("ssid", DEFAULT_SSID);
  currentPass = prefs.getString("pass", DEFAULT_PASS);
  currentServer = prefs.getString("server", DEFAULT_SERVER);
  currentSecret = prefs.getString("secret", DEFAULT_ESP32_SECRET);
  prefs.end();

  Serial.println("\n==========================================");
  Serial.println("[BOOT] Smart USB Charger ESP32 starting...");
  Serial.printf("[CFG] Target WiFi: %s\n", currentSSID.c_str());
  Serial.printf("[CFG] Target Server: %s\n", currentServer.c_str());
  Serial.println("[INFO] Hold BOOT button (GPIO 0) for 3s to open Captive Portal setup");
  Serial.println("==========================================");

  // 3. Open Captive Portal immediately if BOOT is held at startup or Wi-Fi is still placeholder
  if (digitalRead(BOOT_PIN) == LOW) {
    delay(500);
    if (digitalRead(BOOT_PIN) == LOW) {
      Serial.println("[BOOT] BOOT button held -> entering Hotspot setup mode");
      startConfigPortal();
      return;
    }
  }

  if (currentSSID == DEFAULT_SSID || currentSSID.length() == 0) {
    Serial.println("[CFG] Wi-Fi not configured yet -> starting Smart Charger Setup Hotspot");
    startConfigPortal();
    return;
  }

  // 4. Connect to configured STA Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  WiFi.begin(currentSSID.c_str(), currentPass.c_str());

  int attempts = 0;
  Serial.print("[WIFI] Connecting");
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected successfully");
    Serial.println("[NET] ESP32 Local IP: " + WiFi.localIP().toString());
    Serial.printf("[NET] Target Server: %s\n", currentServer.c_str());
    Serial.println("[SYNC] Polling server commands every 2 seconds...");
  } else {
    Serial.printf("\n[WARN] Unable to connect to Wi-Fi '%s' (status=%d)\n", currentSSID.c_str(), WiFi.status());
    Serial.println("[AP] Starting Captive Portal Hotspot...");
    startConfigPortal();
  }
}

void enforceLocalFailsafe() {
  unsigned long nowMs = millis();
  for (int i = 0; i < 4; i++) {
    if (!currentRelayState[i] || portPausedState[i]) continue;
    if (portRemainingMs[i] == 0) {
      setRelayHardware(i, false, "failsafe_zero");
      continue;
    }
    unsigned long elapsed = nowMs - portLastSyncMs[i];
    // Overflow-safe unsigned subtraction; cut power immediately when local timer expires (even offline)
    if (elapsed >= portRemainingMs[i]) {
      portRemainingMs[i] = 0;
      setRelayHardware(i, false, "failsafe_timeout");
    }
  }
}

void loop() {
  // Always run local fail-safe cutoff timer even when disconnected
  enforceLocalFailsafe();

  // Check BOOT button (GPIO 0) hold for 3 seconds
  if (digitalRead(BOOT_PIN) == LOW) {
    if (bootPressStart == 0) bootPressStart = millis();
    else if (millis() - bootPressStart > 3000) {
      Serial.println("\n[BTN] BOOT held 3s -> restarting into Captive Portal setup");
      for (int i = 0; i < 4; i++) setRelayHardware(i, false, "setup_mode");
      startConfigPortal();
      bootPressStart = 0;
      delay(500);
    }
  } else {
    bootPressStart = 0;
  }

  // AP Setup Mode Execution
  if (isApMode) {
    dnsServer.processNextRequest();
    server.handleClient();
    delay(10);
    return;
  }

  // Normal STA Connected Execution
  if (WiFi.status() == WL_CONNECTED) {
    lastDisconnectTime = 0;
    if (millis() - lastPollMs >= 2000) {
      lastPollMs = millis();
      fetchRelayCommands();
    }
    delay(50);
  } else {
    if (lastDisconnectTime == 0) lastDisconnectTime = millis();

    // If disconnected for more than 45 seconds, cut inactive sessions via fail-safe & open AP setup
    if (millis() - lastDisconnectTime > 45000) {
      Serial.println("\n[WARN] Wi-Fi offline > 45s -> opening Hotspot setup mode");
      startConfigPortal();
      return;
    }

    Serial.printf("[WIFI] Disconnected (status=%d), retrying...\n", WiFi.status());
    WiFi.reconnect();
    delay(1000);
  }
}

// ----------------------------------------------------
// Smart Wi-Fi Hotspot & Captive Portal
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
  Serial.println("[AP] Smart Wi-Fi Hotspot Active");
  Serial.printf("[AP] SSID: %s\n", AP_SSID);
  Serial.printf("[AP] URL: http://%s\n", apIP.toString().c_str());
  Serial.println("==========================================");

  dnsServer.start(53, "*", apIP);

  server.on("/", handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/generate_204", handleRoot);
  server.on("/hotspot-detect.html", handleRoot);
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
      String escaped = htmlEscape(ssidName);
      String selected = (ssidName == currentSSID) ? "selected" : "";
      options += "<option value='" + escaped + "' " + selected + ">" + escaped + " (" + String(rssi) + " dBm)</option>";
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
    .icon-box { width: 52px; height: 52px; border-radius: 14px; background: rgba(56,189,248,0.12); color: #38bdf8; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 10px; border: 1px solid rgba(56,189,248,0.28); }
    h2 { font-size: 20px; color: #38bdf8; }
    p { font-size: 13px; color: #94a3b8; margin-top: 4px; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #cbd5e1; }
    select, input { width: 100%; padding: 11px 12px; background: #0f172a; border: 1.5px solid #475569; border-radius: 10px; color: #fff; font-size: 14px; outline: none; }
    select:focus, input:focus { border-color: #38bdf8; }
    .btn { width: 100%; padding: 13px; background: linear-gradient(135deg, #0284c7, #0369a1); border: none; border-radius: 10px; color: #fff; font-size: 15px; font-weight: bold; cursor: pointer; margin-top: 8px; transition: transform 0.18s cubic-bezier(.22,1,.36,1), opacity 0.18s ease; }
    .btn:active { transform: scale(0.98); }
    .footer { text-align: center; font-size: 12px; color: #64748b; margin-top: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="icon-box">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
      </div>
      <h2>Smart USB Charger</h2>
      <p>ตั้งค่า Wi-Fi และข้อมูลเชื่อมต่อเซิร์ฟเวอร์ตู้ชาร์จ</p>
    </div>
    <form action="/save" method="POST">
      <div class="form-group">
        <label>เลือกเครือข่าย Wi-Fi (2.4GHz):</label>
        <select name="ssid" id="ssidSelect">
  )rawliteral";

  html += options;
  html += R"rawliteral(
        </select>
      </div>
      <div class="form-group">
        <label>หรือระบุชื่อ Wi-Fi ด้วยตนเอง:</label>
        <input type="text" name="custom_ssid" placeholder="กรอกกรณีซ่อนชื่อ Wi-Fi">
      </div>
      <div class="form-group">
        <label>รหัสผ่าน Wi-Fi:</label>
        <input type="password" name="password" placeholder="รหัสผ่าน Wi-Fi" required>
      </div>
      <div class="form-group">
        <label>URL เซิร์ฟเวอร์ตู้ชาร์จ (Server URL):</label>
        <input type="text" name="server" value=")rawliteral";
  html += htmlEscape(currentServer);
  html += R"rawliteral(">
      </div>
      <div class="form-group">
        <label>ESP32 Secret Key (ตรงกับค่า ENV ESP32_SECRET บนเซิร์ฟเวอร์):</label>
        <input type="password" name="secret" placeholder="เว้นว่างหากใช้ค่าเดิม">
      </div>
      <button type="submit" class="btn">บันทึกและเชื่อมต่อทันที</button>
    </form>
    <div class="footer">
      ฮอตสปอตตั้งค่าตู้ชาร์จ: SmartCharger-Setup (192.168.4.1)
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
  reqServer.trim();
  if (reqServer.length() == 0) reqServer = DEFAULT_SERVER;
  String reqSecret = server.arg("secret");
  reqSecret.trim();

  if (reqSSID.length() > 0) {
    prefs.begin("charger", false);
    prefs.putString("ssid", reqSSID);
    prefs.putString("pass", reqPass);
    prefs.putString("server", reqServer);
    if (reqSecret.length() > 0) {
      prefs.putString("secret", reqSecret);
    }
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
    <h2>บันทึกการตั้งค่าสำเร็จ</h2>
    <p>ESP32 กำลังรีสตาร์ทเพื่อเชื่อมต่อ Wi-Fi: <strong>)rawliteral";
    reply += htmlEscape(reqSSID);
    reply += R"rawliteral(</strong></p>
    <p style="margin-top:16px;">บอร์ดจะเชื่อมต่อไปยังตู้ชาร์จและเริ่มทำงานทันที</p>
  </div>
</body>
</html>
    )rawliteral";
    server.send(200, "text/html", reply);
    delay(1500);
    ESP.restart();
  } else {
    server.send(400, "text/plain", "กรุณาระบุชื่อ Wi-Fi");
  }
}

void handleNotFound() {
  server.sendHeader("Location", "http://192.168.4.1/", true);
  server.send(302, "text/plain", "");
}

// ----------------------------------------------------
// Relay Commands Fetcher from Cloud Server
// ----------------------------------------------------
void fetchRelayCommands() {
  HTTPClient http;
  String myIp = WiFi.localIP().toString();
  long rssi = WiFi.RSSI();
  // Send ESP32_SECRET strictly in X-ESP32-Secret HTTP header (never in URL query string)
  String url = currentServer + "/api/esp32/command?ip=" + myIp + "&rssi=" + String(rssi);

  WiFiClientSecure secClient;
  if (url.startsWith("https://")) {
    secClient.setInsecure();
    secClient.setTimeout(15000);
    http.begin(secClient, url);
  } else {
    http.begin(url);
  }
  http.setTimeout(15000);
  http.addHeader("X-ESP32-Secret", currentSecret);

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
      unsigned long syncNow = millis();

      for (int i = 0; i < 4; i++) {
        const char* key = PORT_KEYS[i];
        if (!relays[key].isNull()) {
          bool isOn = relays[key]["on"] | false;
          bool isPaused = relays[key]["isPaused"] | false;
          unsigned long remSec = relays[key]["remainingSeconds"] | 0UL;

          portPausedState[i] = isPaused;
          portRemainingMs[i] = remSec * 1000UL;
          portLastSyncMs[i] = syncNow;

          // If server instructs ON but remainingSeconds is positive, update timer; allow direct relay tests when server explicitly sends on=true
          if (isOn && remSec == 0 && !isPaused) {
            // Direct GPIO test mode uses small 30s safety watchdog unless refreshed
            portRemainingMs[i] = 30000UL;
          }

          setRelayHardware(i, isOn, "server_sync");
        }
      }

      if (isFirstConnect) {
        isFirstConnect = false;
        Serial.println("----------------------------------------------");
        Serial.println("[ONLINE] Connected to Smart Charger Server");
        Serial.printf("[NET] ESP32 IP: %s\n", myIp.c_str());
        Serial.printf("[NET] Server: %s\n", currentServer.c_str());
        Serial.println("[READY] Hardware relays synced");
        Serial.println("----------------------------------------------");
      }

      pollCount++;
      if (pollCount >= 5) {
        pollCount = 0;
        Serial.printf("[SYNC] Relays: P1=%s P2=%s P3=%s P4=%s (WiFi: %ld dBm)\n",
                      currentRelayState[0] ? "ON" : "OFF",
                      currentRelayState[1] ? "ON" : "OFF",
                      currentRelayState[2] ? "ON" : "OFF",
                      currentRelayState[3] ? "ON" : "OFF",
                      rssi);
      }
    }
  } else if (httpCode > 0) {
    Serial.printf("[ERR] Server HTTP Status: %d\n", httpCode);
  } else {
    Serial.printf("[ERR] Server unreachable: %s\n", http.errorToString(httpCode).c_str());
  }
  http.end();
}
