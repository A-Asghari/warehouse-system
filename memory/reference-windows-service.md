---
name: reference-windows-service
description: The app runs as Windows service "WarehouseSystem" (WinSW) on the server — how to restart it and where logs are
type: reference
---

- Runs as Windows service `WarehouseSystem` (display name «سیستم انبار»), installed by `Install.bat` → `install.ps1` using WinSW in `C:\WarehouseSystem\service`.
- Auto-starts at boot, no time limit, restarts itself after a crash (10s/30s/60s).
- Restart after code changes: `Restart-Service WarehouseSystem` (or services.msc). Do NOT also start it manually (`npm start / node server.js`) — port 3000 would be taken twice.
- Logs: `C:\WarehouseSystem\service\logs\WarehouseSystem.out.log / .err.log / .wrapper.log` (rolled at 10 MB, 5 kept). The old `service.log` is no longer written.
- Replaced the old Task Scheduler autostart on 2026-09-30: that task had Windows' default 72-hour limit and was stopping the app every 3 days.

**Why:** The user asked for the systems to run as Windows services after repeated outages.

**How to apply:** Use the service for restarts; reinstall by running Install.bat again (it stops and replaces the old service).
