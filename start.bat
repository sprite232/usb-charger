@echo off
title Smart USB Charger Server
color 0A

echo ========================================================
echo       Starting Smart USB Charger System...
echo ========================================================
echo.

cd /d "S:\code\usb-charger"

start http://localhost:3000

node "S:\code\usb-charger\server.js"

pause
