@echo off
rem Starts the bot, or applies a changed .env, then shows its log.
cd /d "%~dp0"
docker compose up -d || (echo Is Docker Desktop running? & pause & exit /b 1)
echo.
echo The bot is running. Closing this window won't stop it.
docker compose logs -f --tail 20 bot
