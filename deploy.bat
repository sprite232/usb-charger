@echo off
chcp 65001 >nul
set "PATH=C:\Users\ROOM_A\.gemini\antigravity\bin;C:\Users\ROOM_A\.gemini\antigravity\bin\node-v20.18.0-win-x64;%PATH%"
cd /d "C:\Users\ROOM_A\.gemini\antigravity\scratch\usb-charger-master"

echo ======================================================================
echo   USB Charger - Firebase Deploy Helper
echo ======================================================================
echo.
echo [1/2] Checking Firebase Login...
call firebase.cmd login
echo.
echo [2/2] Deploying to Firebase Hosting and Firestore Rules...
call firebase.cmd deploy --only hosting,firestore:rules
echo.
echo ======================================================================
echo   Deploy Complete!
echo ======================================================================
echo.
pause
