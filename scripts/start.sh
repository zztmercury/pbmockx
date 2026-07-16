#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$DIR/.venv"
PROXY_PORT="${PROXY_PORT:-8080}"
CONTROL_PORT="${CONTROL_PORT:-9090}"
DEVICE="${DEVICE:-}"

if [ ! -x "$VENV/bin/mitmdump" ]; then
  echo "venv missing. one-time setup:"
  echo "  curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh | sh"
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
echo "=== mitmdump starting ==="
echo "  proxy   : 127.0.0.1:$PROXY_PORT"
echo "  control : http://127.0.0.1:$CONTROL_PORT"
echo "  CLI     : pbmockx flows"
echo

exec "$VENV/bin/mitmdump" -s "$DIR/addon/pbmockx_addon.py" \
  --mode "regular@127.0.0.1:$PROXY_PORT" \
  --set "pbmockx_control_port=$CONTROL_PORT" \
  --flow-detail 1
