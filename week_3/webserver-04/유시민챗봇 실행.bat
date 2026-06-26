@echo off
chcp 65001 >nul
title 유시민 챗봇 서버
cd /d "C:\수경_ai공장장\week_3\webserver-04"

rem 서버(3000포트)가 이미 떠 있는지 확인
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo 유시민 챗봇 서버를 시작합니다...
    start "유시민챗봇서버" /min cmd /c "node server.js"
    rem 서버가 뜰 때까지 잠시 대기
    timeout /t 2 >nul
) else (
    echo 서버가 이미 실행 중입니다. 브라우저만 엽니다.
)

rem 기본 브라우저로 챗봇 열기
start "" "http://localhost:3000"
exit
