/*
  ESP32 demo idea for this project.

  Flow:
  1. Website/Server creates QR or receives cash simulation.
  2. Server stores central charger state.
  3. ESP32 polls /api/esp32/command.
  4. If relayOn is true, ESP32 turns relay on.
  5. ESP32 can report batteryFull back to /api/esp32/report.

  This file is a skeleton. Replace SERVER_URL with your PC IP address,
  for example: http://192.168.1.50:3000
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

#define WIFI_SSID "YOUR_WIFI"
#define WIFI_PASSWORD "YOUR_PASSWORD"
#define SERVER_URL "http://192.168.1.50:3000"

#define RELAY_PIN 26
#define CURRENT_SENSOR_PIN 35
#define COIN_5_PIN 32
#define COIN_10_PIN 33
#define QR_CONFIRM_BUTTON_PIN 21
#define RESET_BUTTON_PIN 22

// TCS3200 color sensor pins for banknote detection.
#define TCS_S0_PIN 14
#define TCS_S1_PIN 27
#define TCS_S2_PIN 25
#define TCS_S3_PIN 13
#define TCS_OUT_PIN 34

// TFT SPI common pins.
#define TFT_SCK_PIN 18
#define TFT_MOSI_PIN 23
#define TFT_CS_PIN 5
#define TFT_DC_PIN 2
#define TFT_RST_PIN 4

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(COIN_5_PIN, INPUT_PULLUP);
  pinMode(COIN_10_PIN, INPUT_PULLUP);
  pinMode(QR_CONFIRM_BUTTON_PIN, INPUT_PULLUP);
  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
  pinMode(TCS_S0_PIN, OUTPUT);
  pinMode(TCS_S1_PIN, OUTPUT);
  pinMode(TCS_S2_PIN, OUTPUT);
  pinMode(TCS_S3_PIN, OUTPUT);
  pinMode(TCS_OUT_PIN, INPUT);
  digitalWrite(RELAY_PIN, LOW);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");
}

void loop() {
  readCommandFromServer();
  delay(3000);
}

void readCommandFromServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(SERVER_URL) + "/api/esp32/command");
  int code = http.GET();

  if (code == 200) {
    String body = http.getString();
    StaticJsonDocument<512> doc;
    deserializeJson(doc, body);

    bool relayOn = doc["relayOn"] | false;
    int remainingMinutes = doc["remainingMinutes"] | 0;

    digitalWrite(RELAY_PIN, relayOn ? HIGH : LOW);

    Serial.print("relay=");
    Serial.print(relayOn ? "ON" : "OFF");
    Serial.print(" remaining=");
    Serial.println(remainingMinutes);

    if (relayOn && isBatteryFull()) {
      reportBatteryFull();
    }
  }

  http.end();
}

void reportBatteryFull() {
  HTTPClient http;
  http.begin(String(SERVER_URL) + "/api/esp32/report");
  http.addHeader("Content-Type", "application/json");
  http.POST("{\"batteryFull\":true}");
  http.end();
}

bool isBatteryFull() {
  int raw = analogRead(CURRENT_SENSOR_PIN);
  return raw < 80;
}
