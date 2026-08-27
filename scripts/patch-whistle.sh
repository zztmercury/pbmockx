#!/usr/bin/env bash
set -euo pipefail

# patch-whistle.sh — patch installed whistle:
#   1. Frontend bundle: custom inspector-tab hidden bug (whistle >= 2.10.8)
#   2. load-plugin.js: CONNECT socket destroy-on-end RSTs unflushed pipe bytes
#   3. lib/https/h2.js: reuse of a closed HTTP/2 session aborts the client request
#
# Background:
#   whistle 2.10.8 refactored the TabMgr component and introduced an evaluation
#   order bug: the container div's className is computed (getHide(s)) BEFORE the
#   tabs.map() callback sets s=false, so the container is always display:none.
#   Plugin custom inspector tabs (via whistleConfig.inspectorsTab) therefore
#   render but stay invisible. Built-in tabs (Raw/Headers/...) are unaffected.
#
# This script:
#   1. Locates the installed whistle bundle
#   2. Reads the whistle version
#   3. Version < 2.10.8 → no patch needed (bug not present)
#   4. Version >= 2.10.8 → patch if the known buggy pattern is present
#   5. Idempotent: already-patched bundles are left alone; if the bundle has
#      neither pattern (upstream fixed/restructured), skip with a warning.
#
# Safe to re-run (e.g. after `npm i -g whistle` upgrades). Backs up the
# original bundle to index.js.pbmockx-bak on first patch.

# --- Colors ---
if [ -t 1 ]; then
    GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
else
    GREEN=''; BLUE=''; YELLOW=''; RED=''; NC=''
fi
info()  { printf "${BLUE}[i]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[✓]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
err()   { printf "${RED}[✗]${NC} %s\n" "$*" >&2; }

# --- Locate whistle bundle ---
if ! command -v w2 &>/dev/null; then
    err "w2 (whistle CLI) not found. Install whistle first: npm i -g whistle"
    exit 1
fi

# Resolve the real path of w2 (handles macOS `readlink` without -f).
W2_BIN="$(command -v w2)"
W2_REAL="$W2_BIN"
if [ -L "$W2_BIN" ]; then
    # resolve symlink chain
    while [ -L "$W2_REAL" ]; do
        W2_REAL="$(cd "$(dirname "$W2_REAL")" && readlink "$W2_REAL" 2>/dev/null || echo "$W2_REAL")"
        case "$W2_REAL" in
            /*) : ;;
            *) W2_REAL="$(cd "$(dirname "$W2_BIN")" && pwd)/$W2_REAL" ;;
        esac
    done
fi
WHISTLE_ROOT="$(cd "$(dirname "$W2_REAL")/.." 2>/dev/null && pwd)"
BUNDLE="$WHISTLE_ROOT/biz/webui/htdocs/js/index.js"

if [ ! -f "$BUNDLE" ]; then
    err "whistle bundle not found: $BUNDLE"
    exit 1
fi

# --- Read whistle version ---
W2_VERSION="$(w2 --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "0.0.0")"
info "whistle $W2_VERSION at $WHISTLE_ROOT"

# --- Version gate: bug exists only in >= 2.10.8 ---
NEED_PATCH=$(node -e "
    const cur = '$W2_VERSION'.split('.').map(Number);
    const min = [2, 10, 8];
    for (let i = 0; i < 3; i++) {
        if ((cur[i]||0) > min[i]) { console.log('yes'); process.exit(0); }
        if ((cur[i]||0) < min[i]) { console.log('no'); process.exit(0); }
    }
    console.log('yes');
" 2>/dev/null || echo "no")

if [ "$NEED_PATCH" = "no" ]; then
    ok "whistle $W2_VERSION < 2.10.8 — skip inspector-tab frontend patch"
fi

# --- Patch 1: inspector-tab frontend (only >= 2.10.8) ---
# The node script prints a status word on stdout and always exits 0, so
# `set -e` never trips on a non-zero exit. Result is captured via output.
if [ "$NEED_PATCH" != "no" ]; then
PATCH_STATUS=$(node -e "
const fs = require('fs');
const F = process.argv[1];
const s = fs.readFileSync(F, 'utf8');

const BUGGY = 'n=t.hide,a=t.active,s=!0;return r.createElement(\"div\",{className:\"fill v-box \"+(t.className||\"\")+o.getHide(s)},t.tabs.map(function(t){var o=t.plugin,l=n||a!==o;return l||(s=!1),e.isInited(t)&&r.createElement(i,{ref:o,key:o,src:t.action,hide:l})}))';
const FIXED_MARKER = 'var c=t.tabs.map(function(t){var o=t.plugin,l=n||a!==o;return l||(s=!1)';

if (s.includes(FIXED_MARKER)) { console.log('already-patched'); process.exit(0); }
if (!s.includes(BUGGY)) { console.log('pattern-not-found'); process.exit(0); }

const FIXED = 'n=t.hide,a=t.active,s=!0;var c=t.tabs.map(function(t){var o=t.plugin,l=n||a!==o;return l||(s=!1),e.isInited(t)&&r.createElement(i,{ref:o,key:o,src:t.action,hide:l})});return r.createElement(\"div\",{className:\"fill v-box \"+(t.className||\"\")+o.getHide(s)},c)';

const bak = F + '.pbmockx-bak';
if (!fs.existsSync(bak)) fs.copyFileSync(F, bak);
fs.writeFileSync(F, s.replace(BUGGY, FIXED));
console.log('patched');
" "$BUNDLE")

case "$PATCH_STATUS" in
    already-patched)
        ok "whistle bundle already patched (custom inspector tabs visible)"
        ;;
    patched)
        ok "whistle bundle patched (custom inspector tabs now visible)"
        info "Restart whistle to pick up changes: w2 restart"
        ;;
    pattern-not-found)
        warn "whistle >= 2.10.8 but the known buggy pattern was not found."
        warn "The bundle may have been fixed upstream (or restructured). Skipping."
        warn "If custom tabs are still blank, re-check: $BUNDLE"
        ;;
    *)
        err "patch failed (unexpected status: $PATCH_STATUS)"
        exit 1
        ;;
esac
fi

# --- Patch 2: pipe CONNECT socket destroy-on-end ---
# whistle emitHttpPipe does socket.on('end', destroySocket). When the plugin
# writes the body + \n0\n terminator in that same 'end' turn, Node may still
# have unflushed bytes; destroy() sends RST and reqWrite never sees the body
# (logs: endPipe + encoder-finish, no write-begin). Wait for encoder 'finish'
# before destroying.
PLUGIN_JS="$WHISTLE_ROOT/lib/plugins/load-plugin.js"
if [ ! -f "$PLUGIN_JS" ]; then
    warn "load-plugin.js not found: $PLUGIN_JS — skip pipe patch"
    exit 0
fi

PIPE_STATUS=$(node -e "
const fs = require('fs');
const F = process.argv[1];
let s = fs.readFileSync(F, 'utf8');
const MARKER = '[wpipe:';
const ORIG = \"            socket.pipe(decoder);\\n            encoder.pipe(socket);\\n            socket.on('end', destroySocket);\\n            httpServer.emit('request', decoder, encoder);\";
const V1 = \"            socket.pipe(decoder);\\n            encoder.pipe(socket);\\n            // pbmockx: wait for encoder flush before destroying the CONNECT\\n            // socket. Immediate destroy() on 'end' RSTs unflushed bytes, so\\n            // reqWrite never sees the body (endPipe + encoder-finish, no write-begin).\\n            socket.on('end', function () {\\n              if (encoder._writableState && encoder._writableState.finished) {\\n                return destroySocket.call(this);\\n              }\\n              encoder.once('finish', destroySocket.bind(this));\\n            });\\n            httpServer.emit('request', decoder, encoder);\";
const NEW = \"            socket.pipe(decoder);\\n            encoder.pipe(socket);\\n            socket.on('end', function () {\\n              var sock = this;\\n              var closeSock = function () {\\n                process.nextTick(function () {\\n                  if (!sock.destroyed && sock.writable) sock.end();\\n                });\\n              };\\n              if (encoder._writableState && encoder._writableState.finished) {\\n                return closeSock();\\n              }\\n              encoder.once('finish', closeSock);\\n            });\\n            httpServer.emit('request', decoder, encoder);\";
if (s.includes(MARKER)) { console.log('already-patched'); process.exit(0); }
const bak = F + '.pbmockx-pipe-bak';
if (!fs.existsSync(bak)) fs.copyFileSync(F, bak);
if (s.includes(V1)) { fs.writeFileSync(F, s.replace(V1, NEW)); console.log('upgraded'); process.exit(0); }
if (s.includes(ORIG)) { fs.writeFileSync(F, s.replace(ORIG, NEW)); console.log('patched'); process.exit(0); }
console.log('pattern-not-found');
" "$PLUGIN_JS")

case "$PIPE_STATUS" in
    already-patched)
        ok "whistle pipe socket already patched (end after encoder flush)"
        ;;
    patched|upgraded)
        ok "whistle pipe socket patched (end after encoder flush, no RST)"
        info "Restart whistle to pick up changes: w2 restart"
        ;;
    pattern-not-found)
        warn "load-plugin.js pipe pattern not found — skip (upstream may have changed)"
        ;;
    *)
        err "pipe patch failed (unexpected status: $PIPE_STATUS)"
        exit 1
        ;;
esac

# --- Patch 3: HTTP/2 session reuse after close ---
# whistle caches Http2Session in clients[name] and reuses it without checking
# closed/destroyed. A dead session then client.request() throws (sync) or
# emits ERR_HTTP2_INVALID_SESSION (async). Sync throw falls back to HTTP/1.1;
# async error hits req.on('error') → abort() → _closed, which also destroys
# in-flight plugin pipe CONNECTs. Drop dead sessions, and on H2 errors drop
# the cache entry and callback() so the request retries over HTTP/1.1.
H2_JS="$WHISTLE_ROOT/lib/https/h2.js"
if [ ! -f "$H2_JS" ]; then
    warn "h2.js not found: $H2_JS — skip H2 session patch"
    exit 0
fi

H2_PATCH="$(cd "$(dirname "$0")" && pwd)/patch-whistle-h2.js"
H2_STATUS=$(node "$H2_PATCH" "$H2_JS")

case "$H2_STATUS" in
    already-patched)
        ok "whistle H2 session already patched (drop closed sessions, fallback HTTP/1.1)"
        ;;
    patched)
        ok "whistle H2 session patched (drop closed sessions, fallback HTTP/1.1)"
        info "Restart whistle to pick up changes: w2 restart"
        ;;
    pattern-not-found)
        warn "h2.js pattern not found — skip (upstream may have changed)"
        ;;
    *)
        err "H2 patch failed (unexpected status: $H2_STATUS)"
        exit 1
        ;;
esac

exit 0
