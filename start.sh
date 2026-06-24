#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$DIR/.venv"
PROXY_PORT="${PROXY_PORT:-8080}"
CONTROL_PORT="${CONTROL_PORT:-9090}"
WEB_PORT="${WEB_PORT:-8081}"
DEVICE="${DEVICE:-}"

if [ ! -x "$VENV/bin/mitmweb" ]; then
  echo "venv missing. one-time setup:"
  echo "  brew install python@3.13"
  echo "  /opt/homebrew/bin/python3.13 -m venv $VENV"
  echo "  $VENV/bin/pip install mitmproxy protobuf requests"
  exit 1
fi

# device proxy via adb reverse (works for both emulator & real device)
if command -v adb >/dev/null 2>&1; then
  DEV="$DEVICE"
  if [ -z "$DEV" ]; then
    DEV="$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
  fi
  if [ -n "$DEV" ]; then
    echo "[*] device: $DEV"
    adb -s "$DEV" reverse tcp:"$PROXY_PORT" tcp:"$PROXY_PORT"
    adb -s "$DEV" shell settings put global http_proxy 127.0.0.1:"$PROXY_PORT"
    echo "[*] device proxy -> 127.0.0.1:$PROXY_PORT (adb reverse)"
  else
    echo "[!] no adb device online; skip device proxy"
  fi
else
  echo "[!] adb not found; skip device proxy"
fi

echo
echo "=== Certificate (install once) ==="
echo "  mitmproxy CA: ~/.mitmproxy/mitmproxy-ca-cert.pem"
echo "  user cert : open http://mitm.it on device (proxy active) -> install CA"
echo "  or push   : adb push ~/.mitmproxy/mitmproxy-ca-cert.pem /sdcard/ -> Settings install"
echo "  system cert: https://docs.mitmproxy.org/stable/howto/install-system-trusted-ca-android/"
echo
echo "=== mitmweb starting ==="
echo "  proxy   : 127.0.0.1:$PROXY_PORT"
echo "  web UI  : http://127.0.0.1:$WEB_PORT"
echo "  control : http://127.0.0.1:$CONTROL_PORT"
echo "  CLI     : mitmproxy-mock flows"
echo

exec "$VENV/bin/mitmweb" -s "$DIR/tap_pb_mock.py" \
  --mode "regular@127.0.0.1:$PROXY_PORT" \
  --web-port "$WEB_PORT" \
  --set "tap_pb_control_port=$CONTROL_PORT"
