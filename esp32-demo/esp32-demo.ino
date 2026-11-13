/*
  ESP32 Smart USB Charger Controller (4 Ports)
  with Smart Wi-Fi Captive Portal, Safe Remote Config, Remote Wi-Fi Rollback (60s),
  and Pull OTA with SHA-256 Verification & 2-Slot Automatic Rollback.

  Default GPIO Pin Mapping (Allowlist: 25, 26, 27, 33 only):
  - Port 1: USB-A 1 -> GPIO 26 (Relay 1)
  - Port 2: USB-A 2 -> GPIO 27 (Relay 2)
  - Port 3: USB-C 1 -> GPIO 25 (Relay 3)
  - Port 4: USB-C 2 -> GPIO 33 (Relay 4)
  - Reset / Config Button: GPIO 0 (BOOT Button on board)

  IMPORTANT Partition Scheme for 2-Slot OTA Rollback (Arduino IDE):
  - Tools -> Partition Scheme -> Choose a 2-OTA partition table such as:
    "Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)" or "Default 4MB with spiffs (1.2MB APP/1.5MB SPIFFS)"
  - Do NOT select "Huge APP (3MB No OTA)" because 2 OTA slots are required for rollback.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_idf_version.h"

#define FW_VERSION "1.1.0"

// Default Placeholders (Override via Captive Portal at 192.168.4.1 — do NOT commit real credentials)
#define DEFAULT_SSID "YOUR_WIFI_SSID"
#define DEFAULT_PASS "YOUR_WIFI_PASSWORD"
#define DEFAULT_SERVER "https://usb-charger.onrender.com"
#define DEFAULT_ESP32_SECRET "CHANGE_ME_ESP32_SECRET"

// SoftAP Config (Change AP passphrase before deploying hardware)
#define AP_SSID "SmartCharger-Setup"
#define AP_PASS "CHANGE_ME_AP_PASS"
#define BOOT_PIN 0

// Safety & Timing Constants
#define MIN_POLL_INTERVAL_MS 1000UL
#define MAX_POLL_INTERVAL_MS 10000UL
#define DEFAULT_POLL_INTERVAL_MS 2000UL
#define OTA_VERIFY_TIMEOUT_MS 90000UL
#define MAX_UNVERIFIED_BOOTS 3
#define DEFAULT_WIFI_ROLLBACK_SEC 60UL

// Optional Root CA PEM for strict TLS verification (e.g., Google Trust Services Root R1/R4 for Firebase Storage & Render).
// Leave empty "" to fall back to TLS without pinned CA while still enforcing strict 64-hex SHA-256 verification on every OTA .bin.
const char* OTA_ROOT_CA_PEM = "";

// Allowed Relay GPIOs (Strict hardware allowlist to prevent boot-glitch or strapping-pin damage)
const int ALLOWED_GPIOS[4] = { 25, 26, 27, 33 };
const int DEFAULT_RELAY_PINS[4] = { 26, 27, 25, 33 };
const char* PORT_KEYS[4] = { "usb-a-1", "usb-a-2", "usb-c-1", "usb-c-2" };

// Global Objects
Preferences prefs;
WebServer server(80);
DNSServer dnsServer;

// Runtime Configuration & State
String currentSSID = DEFAULT_SSID;
String currentPass = DEFAULT_PASS;
String currentServer = DEFAULT_SERVER;
String currentSecret = DEFAULT_ESP32_SECRET;

int relayPins[4] = { 26, 27, 25, 33 };
unsigned long pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
unsigned long currentConfigVersion = 0;

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
unsigned long nextReconnectAttemptMs = 0;
unsigned long reconnectIntervalMs = 2000UL;

// OTA Verification & Rollback Tracking
bool otaPendingVerify = false;
unsigned long otaVerifyDeadlineMs = 0;
String otaPendingId = "";
String lastAttemptedOtaId = "";
String lastHandledCmdId = "";
String lastHandledWifiCmdId = "";
String pendingRollbackReportReason = "";

// Forward Declarations
void fetchRelayCommands();
void enforceLocalFailsafe();
void startConfigPortal();
void handleRoot();
void handleSave();
void handleNotFound();
String htmlEscape(const String& src);
bool areAllRelaysOff();
bool isAllowedRelayGpio(int pin);
void loadValidatedRelayPins();
void checkBootOtaAndWifiRecovery();
void confirmOtaBootValid();
void triggerOtaRollback(const char* reason);
void reportStatusToServer(const char* cmdId = nullptr, const char* cmdStatus = nullptr,
                          const char* wifiCmdId = nullptr, const char* wifiStatus = nullptr,
                          const char* otaId = nullptr, const char* otaStatus = nullptr,
                          const char* otaError = nullptr, const char* configStatus = nullptr);
void applyRemoteConfig(JsonObject cfg);
void handlePendingCommand(JsonObject cmd);
void handlePendingWifi(JsonObject wifiCmd);
void handlePendingOta(JsonObject otaObj);

String htmlEscape(const String& src) {
  String out = src;
  out.replace("&", "&amp;");
  out.replace("<", "&lt;");
  out.replace(">", "&gt;");
  out.replace("\"", "&quot;");
  out.replace("'", "&#39;");
  return out;
}

void configureSecureClient(WiFiClientSecure& client) {
  if (strlen(OTA_ROOT_CA_PEM) > 32) {
    client.setCACert(OTA_ROOT_CA_PEM);
  } else {
    client.setInsecure();
  }
  client.setTimeout(20000);
}

bool isAllowedRelayGpio(int pin) {
  for (int i = 0; i < 4; i++) {
    if (ALLOWED_GPIOS[i] == pin) return true;
  }
  return false;
}

bool areAllRelaysOff() {
  for (int i = 0; i < 4; i++) {
    if (currentRelayState[i]) return false;
  }
  return true;
}

String getRunningPartitionLabel() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  return running ? String(running->label) : String("unknown");
}

bool isTwoSlotOtaAvailable() {
  return esp_ota_get_next_update_partition(NULL) != NULL;
}

void loadValidatedRelayPins() {
  int candidate[4];
  bool valid = true;
  prefs.begin("charger", true);
  candidate[0] = prefs.getInt("gpio0", DEFAULT_RELAY_PINS[0]);
  candidate[1] = prefs.getInt("gpio1", DEFAULT_RELAY_PINS[1]);
  candidate[2] = prefs.getInt("gpio2", DEFAULT_RELAY_PINS[2]);
  candidate[3] = prefs.getInt("gpio3", DEFAULT_RELAY_PINS[3]);
  prefs.end();

  for (int i = 0; i < 4; i++) {
    if (!isAllowedRelayGpio(candidate[i])) {
      valid = false;
      break;
    }
    for (int j = i + 1; j < 4; j++) {
      if (candidate[i] == candidate[j]) {
        valid = false;
        break;
      }
    }
    if (!valid) break;
  }

  for (int i = 0; i < 4; i++) {
    relayPins[i] = valid ? candidate[i] : DEFAULT_RELAY_PINS[i];
  }
}

void setRelayHardware(int idx, bool turnOn, const char* reasonTag) {
  if (idx < 0 || idx >= 4) return;
  if (currentRelayState[idx] != turnOn) {
    currentRelayState[idx] = turnOn;
    digitalWrite(relayPins[idx], turnOn ? HIGH : LOW);
    Serial.printf("[RELAY] Port %d (%s | GPIO %d) -> %s (%s)\n",
                  idx + 1, PORT_KEYS[idx], relayPins[idx],
                  turnOn ? "ON" : "OFF", reasonTag);
  }
}

void triggerOtaRollback(const char* reason) {
  Serial.printf("[OTA-ROLLBACK] Reverting firmware (%s)...\n", reason);
  prefs.begin("charger", false);
  prefs.putBool("ota_pend", false);
  prefs.putInt("ota_boots", 0);
  prefs.putString("ota_rb_rsn", reason);
  prefs.end();

  // 1. Hardware bootloader rollback (when CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE is active)
  esp_ota_mark_app_invalid_rollback_and_reboot();

  // 2. Software fallback: switch boot partition manually to the other valid OTA slot
  const esp_partition_t* other = esp_ota_get_next_update_partition(NULL);
  if (other != NULL) {
    esp_ota_img_states_t otherState = ESP_OTA_IMG_UNDEFINED;
    esp_err_t stErr = esp_ota_get_state_partition(other, &otherState);
    if (stErr == ESP_OK && (otherState == ESP_OTA_IMG_VALID || otherState == ESP_OTA_IMG_UNDEFINED)) {
      if (esp_ota_set_boot_partition(other) == ESP_OK) {
        Serial.printf("[OTA-ROLLBACK] Switched boot partition to %s, rebooting...\n", other->label);
        delay(300);
        ESP.restart();
      }
    }
  }
  Serial.println("[OTA-ROLLBACK] No valid previous partition found; staying in safe AP/recovery");
}

void checkBootOtaAndWifiRecovery() {
  // Recover Wi-Fi if power failed mid-remote-WiFi test
  prefs.begin("charger", false);
  bool wifiTesting = prefs.getBool("wifi_test", false);
  if (wifiTesting) {
    String prevSsid = prefs.getString("prev_ssid", "");
    String prevPass = prefs.getString("prev_pass", "");
    if (prevSsid.length() > 0) {
      Serial.printf("[WIFI-RECOVERY] Restoring previous Wi-Fi '%s' after interrupted test\n", prevSsid.c_str());
      prefs.putString("ssid", prevSsid);
      prefs.putString("pass", prevPass);
      currentSSID = prevSsid;
      currentPass = prevPass;
    }
    prefs.putBool("wifi_test", false);
  }

  bool nvsPending = prefs.getBool("ota_pend", false);
  int otaBoots = prefs.getInt("ota_boots", 0);
  otaPendingId = prefs.getString("ota_pend_id", "");
  lastAttemptedOtaId = prefs.getString("last_ota_id", "");
  lastHandledCmdId = prefs.getString("last_cmd_id", "");
  lastHandledWifiCmdId = prefs.getString("last_wif_id", "");
  pendingRollbackReportReason = prefs.getString("ota_rb_rsn", "");
  prefs.end();

  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t otaState = ESP_OTA_IMG_UNDEFINED;
  bool bootloaderPending = false;
  if (running != NULL && esp_ota_get_state_partition(running, &otaState) == ESP_OK) {
    if (otaState == ESP_OTA_IMG_PENDING_VERIFY) {
      bootloaderPending = true;
    }
  }

  if (bootloaderPending || nvsPending) {
    otaBoots++;
    prefs.begin("charger", false);
    prefs.putInt("ota_boots", otaBoots);
    prefs.end();

    Serial.printf("[OTA] New firmware pending self-verification (boot attempt %d/%d)\n",
                  otaBoots, MAX_UNVERIFIED_BOOTS);
    if (otaBoots > MAX_UNVERIFIED_BOOTS) {
      triggerOtaRollback("max_boot_retries_exceeded");
      return;
    }
    otaPendingVerify = true;
    otaVerifyDeadlineMs = millis() + OTA_VERIFY_TIMEOUT_MS;
  }
}

void confirmOtaBootValid() {
  if (!otaPendingVerify) return;
  otaPendingVerify = false;

  esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
  prefs.begin("charger", false);
  prefs.putBool("ota_pend", false);
  prefs.putInt("ota_boots", 0);
  prefs.putString("ota_ok_ver", FW_VERSION);
  prefs.end();

  Serial.printf("[OTA] Firmware v%s verified with server! Rollback cancelled (err=%d)\n",
                FW_VERSION, (int)err);

  String idCopy = otaPendingId;
  otaPendingId = "";
  reportStatusToServer(nullptr, nullptr, nullptr, nullptr,
                       idCopy.length() ? idCopy.c_str() : nullptr, "verified", nullptr, nullptr);
}

void setup() {
  // 1. Hardware Fail-Safe FIRST: load allowlisted relay GPIOs and force ALL LOW before Wi-Fi starts
  loadValidatedRelayPins();
  for (int i = 0; i < 4; i++) {
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], LOW);
    currentRelayState[i] = false;
  }

  pinMode(BOOT_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  delay(500);

  // 2. Load saved credentials & remote config from NVS Flash
  prefs.begin("charger", true);
  currentSSID = prefs.getString("ssid", DEFAULT_SSID);
  currentPass = prefs.getString("pass", DEFAULT_PASS);
  currentServer = prefs.getString("server", DEFAULT_SERVER);
  currentSecret = prefs.getString("secret", DEFAULT_ESP32_SECRET);
  unsigned long savedPoll = prefs.getULong("poll_ms", DEFAULT_POLL_INTERVAL_MS);
  currentConfigVersion = prefs.getULong("cfg_ver", 0);
  prefs.end();

  if (savedPoll >= MIN_POLL_INTERVAL_MS && savedPoll <= MAX_POLL_INTERVAL_MS) {
    pollIntervalMs = savedPoll;
  }

  // 3. Check OTA verification state & interrupted Wi-Fi test recovery
  checkBootOtaAndWifiRecovery();

  Serial.println("\n==========================================");
  Serial.printf("[BOOT] Smart USB Charger ESP32 v%s (Part: %s, 2-Slot: %s)\n",
                FW_VERSION, getRunningPartitionLabel().c_str(),
                isTwoSlotOtaAvailable() ? "YES" : "NO");
  Serial.printf("[CFG] Relay GPIOs: [%d, %d, %d, %d] | Poll: %lu ms\n",
                relayPins[0], relayPins[1], relayPins[2], relayPins[3], pollIntervalMs);
  Serial.printf("[CFG] Target WiFi: %s\n", currentSSID.c_str());
  Serial.printf("[CFG] Target Server: %s\n", currentServer.c_str());
  Serial.println("[INFO] Hold BOOT button (GPIO 0) for 3s to open Captive Portal setup");
  Serial.println("==========================================");

  // 4. Open Captive Portal immediately if BOOT is held at startup or Wi-Fi is still placeholder
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

  // 5. Connect to configured STA Wi-Fi
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
    Serial.printf("[SYNC] Polling server commands every %lu ms...\n", pollIntervalMs);
  } else {
    Serial.printf("\n[WARN] Unable to connect to Wi-Fi '%s' at startup (status=%d)\n", currentSSID.c_str(), WiFi.status());
    if (otaPendingVerify) {
      triggerOtaRollback("wifi_connect_failed_after_ota");
      return;
    }
    Serial.println("[WIFI] Will continue persistent auto-reconnect in loop()...");
    lastDisconnectTime = millis();
    nextReconnectAttemptMs = millis() + 2000UL;
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

  // OTA Self-Verification Watchdog: rollback automatically if server never confirms within timeout
  if (otaPendingVerify && (long)(millis() - otaVerifyDeadlineMs) >= 0) {
    triggerOtaRollback("server_verify_timeout_90s");
    return;
  }

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
    if (lastDisconnectTime != 0) {
      Serial.println("\n[WIFI] Connection restored! Resuming server sync...");
      lastDisconnectTime = 0;
      nextReconnectAttemptMs = 0;
      reconnectIntervalMs = 2000UL;
    }
    if (millis() - lastPollMs >= pollIntervalMs) {
      lastPollMs = millis();
      fetchRelayCommands();
    }
    delay(50);
  } else {
    if (lastDisconnectTime == 0) {
      lastDisconnectTime = millis();
      nextReconnectAttemptMs = millis() + 1000UL;
      reconnectIntervalMs = 2000UL;
      Serial.printf("[WIFI] Connection lost (status=%d). Entering persistent auto-reconnect mode...\n", WiFi.status());
    }

    // OTA failsafe check
    if (otaPendingVerify && (long)(millis() - otaVerifyDeadlineMs) >= 0) {
      triggerOtaRollback("wifi_lost_during_ota_verify");
      return;
    }

    // Persistent Non-blocking Reconnect with Backoff (Never get trapped in AP mode!)
    unsigned long nowMs = millis();
    if ((long)(nowMs - nextReconnectAttemptMs) >= 0) {
      Serial.printf("[WIFI] Reconnecting to '%s' (offline for %lu s, next retry in %lu s)...\n",
                    currentSSID.c_str(), (nowMs - lastDisconnectTime) / 1000UL, reconnectIntervalMs / 1000UL);
      WiFi.disconnect();
      WiFi.begin(currentSSID.c_str(), currentPass.c_str());

      nextReconnectAttemptMs = nowMs + reconnectIntervalMs;
      reconnectIntervalMs = (reconnectIntervalMs < 15000UL) ? reconnectIntervalMs * 2 : 15000UL;
    }

    delay(100);
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
    .btn { width: 100%; padding: 13px; background: linear-gradient(135deg, #0284c7, #0369a1); border: none; border-radius: 10px; color: #fff; font-size: 15px; font-weight: bold; cursor: pointer; margin-top: 8px; }
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
      <p>ตั้งค่า Wi-Fi และข้อมูลเชื่อมต่อเซิร์ฟเวอร์ตู้ชาร์จ (FW v)rawliteral";
  html += htmlEscape(FW_VERSION);
  html += R"rawliteral()</p>
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
    prefs.putBool("wifi_test", false);
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
// Status Report Helper (POST /api/esp32/report)
// ----------------------------------------------------
void reportStatusToServer(const char* cmdId, const char* cmdStatus,
                          const char* wifiCmdId, const char* wifiStatus,
                          const char* otaId, const char* otaStatus,
                          const char* otaError, const char* configStatus) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  WiFiClientSecure secClient;
  String url = currentServer + "/api/esp32/report";

  if (url.startsWith("https://")) {
    configureSecureClient(secClient);
    http.begin(secClient, url);
  } else {
    http.begin(url);
  }
  http.setTimeout(10000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-ESP32-Secret", currentSecret);

  #if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument rep;
  #else
  StaticJsonDocument<768> rep;
  #endif

  rep["fwVersion"] = FW_VERSION;
  rep["partitionLabel"] = getRunningPartitionLabel();
  rep["rollbackSupported"] = isTwoSlotOtaAvailable();
  rep["pollIntervalMs"] = pollIntervalMs;
  rep["wifiSsid"] = currentSSID;
  rep["freeHeap"] = (unsigned long)ESP.getFreeHeap();
  rep["uptimeSec"] = (unsigned long)(millis() / 1000UL);
  rep["otaPendingVerify"] = otaPendingVerify;

  #if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonArray gpios = rep["relayGpios"].to<JsonArray>();
  #else
  JsonArray gpios = rep.createNestedArray("relayGpios");
  #endif
  for (int i = 0; i < 4; i++) gpios.add(relayPins[i]);

  if (cmdId && cmdStatus) {
    rep["cmdId"] = cmdId;
    rep["cmdStatus"] = cmdStatus;
  }
  if (wifiCmdId && wifiStatus) {
    rep["wifiCmdId"] = wifiCmdId;
    rep["wifiStatus"] = wifiStatus;
  }
  if (otaId) rep["otaId"] = otaId;
  if (otaStatus) rep["otaStatus"] = otaStatus;
  if (otaError) rep["otaError"] = otaError;
  if (configStatus) rep["configStatus"] = configStatus;

  String body;
  serializeJson(rep, body);
  http.POST(body);
  http.end();
}

// ----------------------------------------------------
// Safe Remote Config (Allowlisted GPIOs & Poll Interval)
// ----------------------------------------------------
void applyRemoteConfig(JsonObject cfg) {
  unsigned long cfgVer = cfg["configVersion"] | 0UL;
  if (cfgVer > 0 && cfgVer == currentConfigVersion) return;

  bool changed = false;
  unsigned long newPoll = cfg["pollIntervalMs"] | pollIntervalMs;
  if (newPoll >= MIN_POLL_INTERVAL_MS && newPoll <= MAX_POLL_INTERVAL_MS && newPoll != pollIntervalMs) {
    pollIntervalMs = newPoll;
    changed = true;
    Serial.printf("[CFG] Remote pollIntervalMs updated -> %lu ms\n", pollIntervalMs);
  }

  if (!cfg["portGpioMap"].isNull()) {
    JsonObject gmap = cfg["portGpioMap"].as<JsonObject>();
    int candidate[4];
    bool valid = true;
    bool pinsDiffer = false;

    for (int i = 0; i < 4; i++) {
      int p = gmap[PORT_KEYS[i]] | -1;
      if (!isAllowedRelayGpio(p)) {
        valid = false;
        break;
      }
      for (int j = 0; j < i; j++) {
        if (candidate[j] == p) {
          valid = false;
          break;
        }
      }
      if (!valid) break;
      candidate[i] = p;
      if (candidate[i] != relayPins[i]) pinsDiffer = true;
    }

    if (!valid) {
      Serial.println("[CFG-ERR] Rejected GPIO mapping outside allowlist [25, 26, 27, 33]");
      reportStatusToServer(nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, "rejected_gpio_allowlist");
      return;
    }

    if (pinsDiffer) {
      if (!areAllRelaysOff()) {
        Serial.println("[CFG] Deferring GPIO remap while a relay is active");
        return;
      }
      for (int i = 0; i < 4; i++) {
        digitalWrite(relayPins[i], LOW);
        relayPins[i] = candidate[i];
        pinMode(relayPins[i], OUTPUT);
        digitalWrite(relayPins[i], LOW);
        currentRelayState[i] = false;
      }
      changed = true;
      Serial.printf("[CFG] Relay GPIOs updated -> [%d, %d, %d, %d]\n",
                    relayPins[0], relayPins[1], relayPins[2], relayPins[3]);
    }
  }

  currentConfigVersion = cfgVer;
  prefs.begin("charger", false);
  prefs.putULong("poll_ms", pollIntervalMs);
  prefs.putULong("cfg_ver", currentConfigVersion);
  for (int i = 0; i < 4; i++) {
    String key = "gpio" + String(i);
    prefs.putInt(key.c_str(), relayPins[i]);
  }
  prefs.end();

  if (changed) {
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, "applied");
  }
}

// ----------------------------------------------------
// One-Shot Safe Remote Commands (Restart / Hotspot)
// ----------------------------------------------------
void handlePendingCommand(JsonObject cmd) {
  String cmdId = cmd["cmdId"] | "";
  String action = cmd["action"] | "";
  if (cmdId.length() == 0 || cmdId == lastHandledCmdId) return;

  if (!areAllRelaysOff()) {
    Serial.printf("[CMD] Deferred '%s' (%s): relay still active\n", action.c_str(), cmdId.c_str());
    reportStatusToServer(cmdId.c_str(), "deferred_port_active");
    return;
  }

  lastHandledCmdId = cmdId;
  prefs.begin("charger", false);
  prefs.putString("last_cmd_id", lastHandledCmdId);
  prefs.end();

  if (action == "restart") {
    Serial.printf("[CMD] Executing remote RESTART (%s)\n", cmdId.c_str());
    reportStatusToServer(cmdId.c_str(), "executed");
    delay(400);
    ESP.restart();
  } else if (action == "hotspot") {
    Serial.printf("[CMD] Executing remote HOTSPOT (%s)\n", cmdId.c_str());
    reportStatusToServer(cmdId.c_str(), "executed");
    delay(300);
    startConfigPortal();
  } else {
    reportStatusToServer(cmdId.c_str(), "rejected");
  }
}

// ----------------------------------------------------
// Remote Wi-Fi Change with 60s Automatic Rollback
// ----------------------------------------------------
bool verifyServerReachable() {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  WiFiClientSecure secClient;
  String url = currentServer + "/api/esp32/command?ip=" + WiFi.localIP().toString() + "&fw=" + String(FW_VERSION);

  if (url.startsWith("https://")) {
    configureSecureClient(secClient);
    http.begin(secClient, url);
  } else {
    http.begin(url);
  }
  http.setTimeout(10000);
  http.addHeader("X-ESP32-Secret", currentSecret);
  int code = http.GET();
  http.end();
  return code == 200;
}

void handlePendingWifi(JsonObject wifiCmd) {
  String wifiCmdId = wifiCmd["wifiCmdId"] | "";
  String newSsid = wifiCmd["ssid"] | "";
  String newPass = wifiCmd["password"] | "";
  unsigned long timeoutSec = wifiCmd["timeoutSec"] | DEFAULT_WIFI_ROLLBACK_SEC;
  if (timeoutSec < 30) timeoutSec = 30;
  if (timeoutSec > 120) timeoutSec = 120;

  if (wifiCmdId.length() == 0 || newSsid.length() == 0 || wifiCmdId == lastHandledWifiCmdId) return;

  if (!areAllRelaysOff()) {
    Serial.printf("[WIFI-CMD] Deferred Wi-Fi change (%s): relay still active\n", wifiCmdId.c_str());
    reportStatusToServer(nullptr, nullptr, wifiCmdId.c_str(), "deferred_port_active");
    return;
  }

  lastHandledWifiCmdId = wifiCmdId;
  String prevSsid = currentSSID;
  String prevPass = currentPass;

  // Persist backup credentials before switching so even a brownout rolls back safely
  prefs.begin("charger", false);
  prefs.putString("last_wif_id", lastHandledWifiCmdId);
  prefs.putString("prev_ssid", prevSsid);
  prefs.putString("prev_pass", prevPass);
  prefs.putBool("wifi_test", true);
  prefs.putString("ssid", newSsid);
  prefs.putString("pass", newPass);
  prefs.end();

  currentSSID = newSsid;
  currentPass = newPass;

  Serial.printf("[WIFI-CMD] Testing new Wi-Fi '%s' (timeout %lu s)...\n", newSsid.c_str(), timeoutSec);
  WiFi.disconnect();
  delay(200);
  WiFi.begin(newSsid.c_str(), newPass.c_str());

  unsigned long startMs = millis();
  unsigned long deadlineMs = startMs + (timeoutSec * 1000UL);
  bool connectedAndVerified = false;

  while ((long)(millis() - deadlineMs) < 0) {
    enforceLocalFailsafe();
    if (WiFi.status() == WL_CONNECTED) {
      if (verifyServerReachable()) {
        connectedAndVerified = true;
        break;
      }
    }
    delay(500);
  }

  if (connectedAndVerified) {
    prefs.begin("charger", false);
    prefs.putBool("wifi_test", false);
    prefs.end();
    Serial.printf("[WIFI-CMD] New Wi-Fi '%s' verified with server!\n", newSsid.c_str());
    reportStatusToServer(nullptr, nullptr, wifiCmdId.c_str(), "applied");
    return;
  }

  // Rollback to previous Wi-Fi
  Serial.printf("[WIFI-CMD] Failed to reach server on '%s' within %lu s -> rolling back to '%s'\n",
                newSsid.c_str(), timeoutSec, prevSsid.c_str());
  currentSSID = prevSsid;
  currentPass = prevPass;
  prefs.begin("charger", false);
  prefs.putString("ssid", prevSsid);
  prefs.putString("pass", prevPass);
  prefs.putBool("wifi_test", false);
  prefs.end();

  WiFi.disconnect();
  delay(200);
  WiFi.begin(prevSsid.c_str(), prevPass.c_str());

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 40) {
    enforceLocalFailsafe();
    delay(500);
    retry++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    reportStatusToServer(nullptr, nullptr, wifiCmdId.c_str(), "rolled_back");
  }
}

// ----------------------------------------------------
// Pull OTA with Streaming SHA-256 & 2-Slot Rollback
// ----------------------------------------------------
void handlePendingOta(JsonObject otaObj) {
  String otaId = otaObj["otaId"] | "";
  String version = otaObj["version"] | "";
  String firmwareUrl = otaObj["firmwareUrl"] | "";
  String expectedSha256 = otaObj["sha256"] | "";
  bool force = otaObj["force"] | false;

  expectedSha256.toLowerCase();

  if (otaId.length() == 0 || firmwareUrl.length() == 0) return;
  if (otaId == lastAttemptedOtaId) return;
  if (!force && version == FW_VERSION) return;

  // 1. Safety Gate: Never update while any relay is active
  if (!areAllRelaysOff()) {
    Serial.printf("[OTA] Deferred (%s): active relay detected\n", otaId.c_str());
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "deferred_port_active");
    return;
  }

  // 2. Validate HTTPS & 64-char SHA-256 from separate Admin channel
  if (!firmwareUrl.startsWith("https://")) {
    Serial.println("[OTA-ERR] Firmware URL must be HTTPS");
    lastAttemptedOtaId = otaId;
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "https_required");
    return;
  }
  if (expectedSha256.length() != 64) {
    Serial.println("[OTA-ERR] Invalid SHA-256 length (expected 64 hex chars)");
    lastAttemptedOtaId = otaId;
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "invalid_sha256_format");
    return;
  }

  // 3. Ensure 2-slot OTA partition table is flashed
  if (!isTwoSlotOtaAvailable()) {
    Serial.println("[OTA-ERR] No secondary OTA partition! Reflash once with a 2-OTA partition scheme.");
    lastAttemptedOtaId = otaId;
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "no_2nd_ota_partition");
    return;
  }

  lastAttemptedOtaId = otaId;
  prefs.begin("charger", false);
  prefs.putString("last_ota_id", lastAttemptedOtaId);
  prefs.end();

  Serial.printf("[OTA] Starting Pull OTA %s -> v%s\n", otaId.c_str(), version.c_str());
  reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "downloading");

  HTTPClient http;
  WiFiClientSecure secClient;
  configureSecureClient(secClient);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(30000);

  if (!http.begin(secClient, firmwareUrl)) {
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "http_begin_failed");
    return;
  }

  int httpCode = http.GET();
  if (httpCode != HTTP_CODE_OK) {
    String err = "http_status_" + String(httpCode);
    http.end();
    Serial.printf("[OTA-ERR] Download failed: %s\n", err.c_str());
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", err.c_str());
    return;
  }

  int contentLength = http.getSize();
  if (contentLength <= 0) {
    http.end();
    Serial.println("[OTA-ERR] Unknown or empty Content-Length");
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "invalid_content_length");
    return;
  }

  if (!Update.begin((size_t)contentLength, U_FLASH)) {
    http.end();
    Serial.printf("[OTA-ERR] Update.begin failed (err=%d)\n", Update.getError());
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "update_begin_failed");
    return;
  }

  reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "flashing");

  WiFiClient* stream = http.getStreamPtr();
  mbedtls_sha256_context shaCtx;
  mbedtls_sha256_init(&shaCtx);
  #if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
  mbedtls_sha256_starts(&shaCtx, 0);
  #else
  mbedtls_sha256_starts_ret(&shaCtx, 0);
  #endif

  uint8_t buf[1024];
  size_t totalRead = 0;
  unsigned long lastDataMs = millis();

  while (totalRead < (size_t)contentLength) {
    if (!areAllRelaysOff()) {
      Update.abort();
      mbedtls_sha256_free(&shaCtx);
      http.end();
      reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "aborted_relay_active");
      return;
    }

    size_t avail = stream->available();
    if (avail > 0) {
      size_t toRead = avail > sizeof(buf) ? sizeof(buf) : avail;
      int readLen = stream->readBytes(buf, toRead);
      if (readLen > 0) {
        #if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
        mbedtls_sha256_update(&shaCtx, buf, (size_t)readLen);
        #else
        mbedtls_sha256_update_ret(&shaCtx, buf, (size_t)readLen);
        #endif

        if (Update.write(buf, (size_t)readLen) != (size_t)readLen) {
          Update.abort();
          mbedtls_sha256_free(&shaCtx);
          http.end();
          Serial.println("[OTA-ERR] Flash write error");
          reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "flash_write_error");
          return;
        }
        totalRead += (size_t)readLen;
        lastDataMs = millis();
      }
    } else {
      if (!http.connected() && totalRead < (size_t)contentLength) break;
      if (millis() - lastDataMs > 15000UL) break;
      delay(5);
    }
  }

  uint8_t digest[32];
  #if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
  mbedtls_sha256_finish(&shaCtx, digest);
  #else
  mbedtls_sha256_finish_ret(&shaCtx, digest);
  #endif
  mbedtls_sha256_free(&shaCtx);
  http.end();

  if (totalRead != (size_t)contentLength) {
    Update.abort();
    Serial.printf("[OTA-ERR] Incomplete download (%u/%d bytes)\n", (unsigned)totalRead, contentLength);
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "download_incomplete");
    return;
  }

  char actualHex[65];
  for (int i = 0; i < 32; i++) {
    sprintf(&actualHex[i * 2], "%02x", digest[i]);
  }
  actualHex[64] = '\0';

  if (expectedSha256 != String(actualHex)) {
    Update.abort();
    Serial.printf("[OTA-ERR] SHA-256 MISMATCH! Expected=%s Actual=%s\n",
                  expectedSha256.c_str(), actualHex);
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "sha256_mismatch");
    return;
  }

  if (!Update.end(true)) {
    Serial.printf("[OTA-ERR] Update.end failed (err=%d)\n", Update.getError());
    reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "failed", "update_end_failed");
    return;
  }

  // Mark pending self-verification BEFORE rebooting into the new slot
  prefs.begin("charger", false);
  prefs.putBool("ota_pend", true);
  prefs.putInt("ota_boots", 0);
  prefs.putString("ota_pend_id", otaId);
  prefs.end();

  Serial.println("[OTA] SHA-256 verified! Written to inactive slot. Rebooting to verify...");
  reportStatusToServer(nullptr, nullptr, nullptr, nullptr, otaId.c_str(), "rebooting");
  delay(400);
  ESP.restart();
}

// ----------------------------------------------------
// Relay Commands Fetcher from Cloud Server
// ----------------------------------------------------
void fetchRelayCommands() {
  HTTPClient http;
  String myIp = WiFi.localIP().toString();
  long rssi = WiFi.RSSI();
  // Send ESP32_SECRET strictly in X-ESP32-Secret HTTP header (never in URL query string)
  String url = currentServer + "/api/esp32/command?ip=" + myIp
             + "&rssi=" + String(rssi)
             + "&fw=" + String(FW_VERSION)
             + "&part=" + getRunningPartitionLabel()
             + "&pollMs=" + String(pollIntervalMs)
             + "&otaPending=" + String(otaPendingVerify ? "1" : "0");

  WiFiClientSecure secClient;
  if (url.startsWith("https://")) {
    configureSecureClient(secClient);
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
    DynamicJsonDocument doc(3072);
    #endif
    DeserializationError error = deserializeJson(doc, payload);

    if (!error && (doc["connected"] | false)) {
      // Self-verify newly booted OTA firmware once server connection succeeds
      if (otaPendingVerify) {
        confirmOtaBootValid();
      }

      // Report any previous rollback event once back online
      if (pendingRollbackReportReason.length() > 0) {
        String rsn = pendingRollbackReportReason;
        pendingRollbackReportReason = "";
        prefs.begin("charger", false);
        prefs.putString("ota_rb_rsn", "");
        prefs.end();
        reportStatusToServer(nullptr, nullptr, nullptr, nullptr, nullptr, "rolled_back", rsn.c_str());
      }

      if (!doc["relays"].isNull()) {
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

            if (isOn && remSec == 0 && !isPaused) {
              portRemainingMs[i] = 30000UL;
            }

            setRelayHardware(i, isOn, "server_sync");
          }
        }
      }

      if (!doc["remoteConfig"].isNull()) {
        applyRemoteConfig(doc["remoteConfig"].as<JsonObject>());
      }

      if (!doc["pendingCommand"].isNull()) {
        handlePendingCommand(doc["pendingCommand"].as<JsonObject>());
      }

      if (!doc["pendingWifi"].isNull()) {
        handlePendingWifi(doc["pendingWifi"].as<JsonObject>());
      }

      if (!doc["ota"].isNull()) {
        handlePendingOta(doc["ota"].as<JsonObject>());
      }

      if (isFirstConnect) {
        isFirstConnect = false;
        Serial.println("----------------------------------------------");
        Serial.printf("[ONLINE] Connected to Smart Charger Server (FW v%s)\n", FW_VERSION);
        Serial.printf("[NET] ESP32 IP: %s\n", myIp.c_str());
        Serial.printf("[NET] Server: %s\n", currentServer.c_str());
        Serial.println("[READY] Hardware relays synced");
        Serial.println("----------------------------------------------");
      }

      pollCount++;
      if (pollCount >= 5) {
        pollCount = 0;
        Serial.printf("[SYNC] Relays: P1=%s P2=%s P3=%s P4=%s (WiFi: %ld dBm | FW: %s)\n",
                      currentRelayState[0] ? "ON" : "OFF",
                      currentRelayState[1] ? "ON" : "OFF",
                      currentRelayState[2] ? "ON" : "OFF",
                      currentRelayState[3] ? "ON" : "OFF",
                      rssi, FW_VERSION);
      }
    }
  } else if (httpCode > 0) {
    Serial.printf("[ERR] Server HTTP Status: %d\n", httpCode);
  } else {
    Serial.printf("[ERR] Server unreachable: %s\n", http.errorToString(httpCode).c_str());
  }
  http.end();
}
