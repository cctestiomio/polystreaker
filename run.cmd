@echo off
cd /d "%~dp0"
npm run start -- --baseSlug "$BaseSlug" --count $Count --minStreak $MinStreak --maxStreak $MaxStreak --roundSeconds $RoundSeconds
pause