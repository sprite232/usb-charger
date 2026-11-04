# Antigravity Workspace Instruction & Memory
> You are working on the **Smart USB Charger (ตู้ชาร์จมือถืออัจฉริยะ 4 ช่อง)** project.

Always read `PROJECT_MEMORY.md` at the root of this workspace. It contains the complete history, requirements, architecture, pin mappings, payment accounts, secrets, and rules.

Key highlights:
- 4 Ports: USB-A 1 (GPIO 26), USB-A 2 (GPIO 27), USB-C 1 (GPIO 25), USB-C 2 (GPIO 33).
- SoftAP: `SmartCharger-Setup` (pass: `admin1234`, IP: `192.168.4.1`, hold BOOT GPIO 0 for 3s to trigger).
- Cloud Backend: `https://usb-charger.onrender.com`
- Frontend: `https://usb-charger-project.web.app`
- TrueMoney & PromptPay: `096-967-9951` (ศุภกฤต สอนบุญมา)
- Admin accounts: `palmtawanlaothaisong00@gmail.com`, `sukitlowkey@gmail.com`
- Admin PINs: `admin1234`, `15152921Ss`
- Port Holding: Single source of truth. When a user clicks a port, server locks it to `pending_payment` immediately so other users cannot conflict.
