const generatePayload = require("promptpay-qr");
const QRCode = require("qrcode");

// เบอร์ PromptPay
const phoneNumber = "0969679951";

// จำนวนเงิน
const amount = 150;

// สร้าง payload
const payload = generatePayload(phoneNumber, { amount });

console.log(payload);

// สร้างไฟล์ QR
QRCode.toFile("qr.png", payload, function (err) {
    if (err) throw err;

    console.log("สร้าง QR สำเร็จ");
});