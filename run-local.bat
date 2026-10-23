@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js غير مثبت. حمّله من https://nodejs.org ثم أعد التشغيل & pause & exit /b 1)
if not exist node_modules (echo جاري تثبيت الحزم لأول مرة... & call npm install || (pause & exit /b 1))
start "" http://localhost:5173
call npm run dev
pause
