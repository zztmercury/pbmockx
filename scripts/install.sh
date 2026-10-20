#!/usr/bin/env bash
set -euo pipefail

# pbmockx install.sh — native proxy + mock + web UI.
#
# Usage:
#   One-line:  sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"
#   Local:     ./scripts/install.sh
#   Update:    ./scripts/install.sh --update
#   Uninstall: ./scripts/install.sh --uninstall [--purge]
#
# Layout:
#   install dir: ~/.pbmockx/app        (code; PBMOCKX_INSTALL_DIR overrides)
#   data dir:    ~/.pbmockx            (rules.yaml, mock-data, ca, logs)
#
# No whistle is installed or required.

REPO_URL="https://github.com/zztmercury/pbmockx.git"
INSTALL_DIR_DEFAULT="${PBMOCKX_INSTALL_DIR:-$HOME/.pbmockx/app}"
DATA_DIR_DEFAULT="${PBMOCKX_DATA_DIR:-$HOME/.pbmockx}"

if [ -t 1 ]; then
    GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
else
    GREEN=''; BLUE=''; YELLOW=''; RED=''; BOLD=''; NC=''
fi
info()  { printf "${BLUE}[i]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[✓]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
err()   { printf "${RED}[✗]${NC} %s\n" "$*" >&2; }

UPDATE=0
UNINSTALL=0
PURGE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --update)    UPDATE=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --purge)     PURGE=1; shift ;;
        --yes|-y)    shift ;;
        --help|-h)   echo "Usage: install.sh [--update] [--uninstall [--purge]] [--yes]"; exit 0 ;;
        *)           err "Unknown option: $1"; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd 2>/dev/null)" || ""
PROJECT_ROOT=""

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../package.json" ] && [ -f "$SCRIPT_DIR/../VERSION" ]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    PROJECT_ROOT="$INSTALL_DIR_DEFAULT"
    if [ -d "$PROJECT_ROOT/.git" ]; then
        if [ $UPDATE -eq 1 ] || [ $UNINSTALL -eq 0 ]; then
            info "Updating pbmockx at $PROJECT_ROOT..."
            (cd "$PROJECT_ROOT" && git pull --quiet) || warn "git pull failed, using existing checkout"
        fi
    elif [ $UNINSTALL -eq 1 ]; then
        warn "No pbmockx checkout at $PROJECT_ROOT"
    else
        info "Cloning pbmockx to $PROJECT_ROOT..."
        mkdir -p "$(dirname "$PROJECT_ROOT")"
        git clone --quiet "$REPO_URL" "$PROJECT_ROOT" || { err "git clone failed"; exit 1; }
    fi
fi

# --- Uninstall ---
if [ $UNINSTALL -eq 1 ]; then
    info "Uninstalling pbmockx..."
    if command -v pbmockx >/dev/null 2>&1; then
        pbmockx stop >/dev/null 2>&1 || true
    elif [ -f "$PROJECT_ROOT/bin/pbmockx.js" ] && [ -d "$PROJECT_ROOT/dist" ]; then
        node "$PROJECT_ROOT/bin/pbmockx.js" stop >/dev/null 2>&1 || true
    fi
    # Remove the old whistle plugin if it is still registered (best effort).
    if command -v w2 >/dev/null 2>&1; then
        w2 uninstall whistle.pbmockx >/dev/null 2>&1 || true
    fi
    npm unlink -g pbmockx >/dev/null 2>&1 || true
    npm unlink -g whistle.pbmockx >/dev/null 2>&1 || true
    if [ -d "$PROJECT_ROOT/skill" ] && command -v node >/dev/null 2>&1 && [ -f "$PROJECT_ROOT/dist/src/cli/index.js" ]; then
        node "$PROJECT_ROOT/bin/pbmockx.js" skill uninstall >/dev/null 2>&1 || true
    else
        rm -f "$HOME/.agents/skills/pbmockx" "$HOME/.claude/skills/pbmockx" 2>/dev/null || true
    fi
    if [ "$PROJECT_ROOT" = "$INSTALL_DIR_DEFAULT" ] && [ -d "$PROJECT_ROOT" ]; then
        info "Removing $PROJECT_ROOT..."
        rm -rf "$PROJECT_ROOT"
    fi
    if [ $PURGE -eq 1 ]; then
        warn "Removing data directory $DATA_DIR_DEFAULT (rules, mock data, CA, logs)..."
        rm -rf "$DATA_DIR_DEFAULT"
    else
        info "Kept data directory: $DATA_DIR_DEFAULT (use --purge to delete)"
    fi
    ok "Uninstalled."
    exit 0
fi

# --- Step 1: Node ---
info "Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
    err "Node.js not found. Install from https://nodejs.org/ (>= 18)"
    exit 1
fi
NODE_MAJOR="$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
    err "Node.js $(node --version) found, requires >= 18"
    exit 1
fi
ok "Node.js $(node --version)"

# --- Step 2: Install deps + build ---
info "Installing dependencies and building..."
cd "$PROJECT_ROOT"
if [ ! -d node_modules ]; then
    npm install --no-audit --no-fund || { err "npm install failed"; exit 1; }
else
    npm install --no-audit --no-fund >/dev/null 2>&1 || warn "npm install had warnings (continuing)"
fi
npm run build || { err "TypeScript build failed"; exit 1; }
ok "Build complete"

# --- Step 3: npm link ---
info "Linking pbmockx command..."
if npm link --silent 2>/dev/null; then
    ok "pbmockx linked"
else
    warn "npm link failed (may need sudo); use: node $PROJECT_ROOT/bin/pbmockx.js <cmd>"
fi

# --- Step 4: agent skill ---
info "Installing SKILL.md for agents..."
node "$PROJECT_ROOT/bin/pbmockx.js" skill install >/dev/null 2>&1 || warn "Skill install failed (run: pbmockx skill install)"

# --- Step 5: start daemon ---
info "Starting pbmockx daemon..."
if command -v pbmockx >/dev/null 2>&1; then
    if pbmockx start >/dev/null 2>&1; then
        ok "Daemon started"
    else
        warn "Could not start daemon. Run 'pbmockx start' to see the error (check port 8899)."
        pbmockx logs -n 20 2>/dev/null || true
    fi
else
    node "$PROJECT_ROOT/bin/pbmockx.js" start >/dev/null 2>&1 && ok "Daemon started" || warn "Start it with: node $PROJECT_ROOT/bin/pbmockx.js start"
fi

echo ""
ok "pbmockx v$(cat "$PROJECT_ROOT/VERSION") installed"
echo ""
info "Next steps:"
echo "  1. Install the CA on this machine:  pbmockx ca"
echo "  2. Point your HTTP/HTTPS proxy at: 127.0.0.1:8899"
echo "  3. Open the Web UI:                 pbmockx web"
echo "  4. Health check:                    pbmockx doctor"
echo ""
info "Android: pbmockx connect-android"
info "Data directory: $DATA_DIR_DEFAULT"
