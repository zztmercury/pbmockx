#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$DIR/.venv"
PROXY_PORT="${PROXY_PORT:-8080}"
CONTROL_PORT="${CONTROL_PORT:-9090}"
WEB_PORT="${WEB_PORT:-8081}"

if [ ! -x "$VENV/bin/mitmweb" ]; then
  echo "venv missing. one-time setup:"
  echo "  curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh | sh"
  exit 1
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
echo "  control : http://127.0.0.1:$CONTROL_PORT"
echo "  web UI  : http://127.0.0.1:$WEB_PORT (password: pbmockx)"
echo "  CLI     : pbmockx flows"
echo

exec "$VENV/bin/mitmweb" -s "$DIR/addon/pbmockx_addon.py" \
  --mode "regular@127.0.0.1:$PROXY_PORT" \
  --set "pbmockx_control_port=$CONTROL_PORT" \
  --set "web_password=pbmockx" \
  --web-port "$WEB_PORT" \
  --no-web-open-browser
