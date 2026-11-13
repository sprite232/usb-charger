@echo off
chcp 65001 >nul
title Firebase Auto Deploy - USB Charger
color 0B

echo ======================================================================
echo   ระบบ Deploy Firebase Hosting & Firestore Rules (USB Charger)
echo ======================================================================
echo.

cd /d "%~dp0"
node deploy-firebase.js

echo.
echo ======================================================================
echo   กดปุ่มใดๆ เพื่อปิดหน้าต่างนี้...
echo ======================================================================
pause >nul
