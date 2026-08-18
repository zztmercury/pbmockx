#!/usr/bin/env bash
set -euo pipefail

# patch-whistle.sh — patch whistle's frontend bundle to fix the custom
# inspector-tab hidden bug (whistle >= 2.10.8 regression).
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
    ok "whistle $W2_VERSION < 2.10.8 — no patch needed"
    exit 0
fi

# --- Apply patch (idempotent) ---
# The node script prints a status word on stdout and always exits 0, so
# `set -e` never trips on a non-zero exit. Result is captured via output.
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

exit 0
