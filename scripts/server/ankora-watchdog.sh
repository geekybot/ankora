#!/bin/sh
# Restart the keeper after two failed health checks in a row (one a minute). systemd already restarts a crash;
# this catches a keeper that is alive but has stopped pushing prices (/health answers 503 after 120 s).
F=/run/ankora-watchdog.fails
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://localhost:8080/health)
if [ "$code" = 200 ]; then rm -f "$F"; exit 0; fi
n=$(( $(cat "$F" 2>/dev/null || echo 0) + 1 )); echo $n > "$F"
logger -t ankora-watchdog "keeper health $code (fail $n)"
if [ $n -ge 2 ]; then logger -t ankora-watchdog "restarting ankora-keeper"; systemctl restart ankora-keeper; rm -f "$F"; fi
