#!/usr/bin/env bash
set -euo pipefail

# pbmockx install.sh — whistle plugin installer (OMZ-style one-line supported)
#
# Usage:
#   One-line:  sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"
#   Local:     ./scripts/install.sh
#   Update:    ./scripts/install.sh --update
#   Uninstall: ./scripts/install.sh --uninstall
#
# This script:
#   1. Clones repo (if running remotely)
#   2. Checks Node.js >= 18
#   3. Checks/installs whistle (version >= 2.9.100)
#   4. Installs whistle.pbmockx plugin (build + register)
#   5. npm link (enables `pbmockx` short command)
#   6. pbmockx skill install (agent docs)
#   7. Prompts w2 ca (PC root certificate)

REPO_URL="https://github.com/zztmercury/pbmockx.git"
INSTALL_DIR_DEFAULT="$HOME/.pbmockx"

# --- Colors ---
if [ -t 1 ]; then
    GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
else
    GREEN=''; BLUE=''; YELLOW=''; RED=''; BOLD=''; NC=''
fi

info()  { printf "${BLUE}[i]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[✓]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
err()   { printf "${RED}[✗]${NC} %s\n" "$*" >&2; }

# --- Parse args ---
UPDATE=0
UNINSTALL=0
YES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --update)    UPDATE=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --yes|-y)    YES=1; shift ;;
        --help|-h)   echo "Usage: install.sh [--update] [--uninstall] [--yes]"; exit 0 ;;
        *)           err "Unknown option: $1"; exit 1 ;;
    esac
done

# --- Detect: local vs remote install ---
# If running from curl|sh, SCRIPT_DIR won't have the repo. Clone it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd 2>/dev/null)" || ""
PROJECT_ROOT=""
PLUGIN_DIR=""

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../whistle-plugin/package.json" ]; then
    # Local install — script is inside the repo
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    PLUGIN_DIR="$PROJECT_ROOT/whistle-plugin"
else
    # Remote install — clone the repo
    INSTALL_DIR="${PBMOCKX_DIR:-$INSTALL_DIR_DEFAULT}"
    if [ -d "$INSTALL_DIR" ]; then
        if [ $UPDATE -eq 1 ] || [ -d "$INSTALL_DIR/.git" ]; then
            info "Updating pbmockx at $INSTALL_DIR..."
            cd "$INSTALL_DIR"
            git pull --quiet || warn "git pull failed, continuing with existing version"
        else
            err "$INSTALL_DIR already exists and is not a git repo. Remove it or set PBMOCKX_DIR."
            exit 1
        fi
    else
        info "Cloning pbmockx to $INSTALL_DIR..."
        git clone --quiet "$REPO_URL" "$INSTALL_DIR" || { err "git clone failed"; exit 1; }
    fi
    PROJECT_ROOT="$INSTALL_DIR"
    PLUGIN_DIR="$PROJECT_ROOT/whistle-plugin"
fi

NODE_MIN_MAJOR=18
WHISTLE_MIN="2.9.100"

# --- Uninstall ---
if [ $UNINSTALL -eq 1 ]; then
    info "Uninstalling pbmockx..."
    # Remove pipe rule from whistle
    PIPE_JS="/tmp/.pbmockx-pipe.js"
    cat > "$PIPE_JS" << 'PIPEOF'
exports.name = 'pbmockx-pipe';
exports.rules = '';
PIPEOF
    w2 add "$PIPE_JS" --force 2>/dev/null || true
    rm -f "$PIPE_JS"
    # Unregister plugin
    w2 uninstall whistle.pbmockx 2>/dev/null || true
    npm unlink -g whistle.pbmockx 2>/dev/null || true
    pbmockx skill uninstall 2>/dev/null || true
    if [ -d "$INSTALL_DIR_DEFAULT" ] && [ "$PROJECT_ROOT" = "$INSTALL_DIR_DEFAULT" ]; then
        info "Removing $INSTALL_DIR_DEFAULT..."
        rm -rf "$INSTALL_DIR_DEFAULT"
    fi
    ok "Uninstalled. Run: w2 restart"
    exit 0
fi

# --- Step 1: Check Node.js ---
info "Checking Node.js..."
if ! command -v node &>/dev/null; then
    err "Node.js not found. Install from https://nodejs.org/ (>= v$NODE_MIN_MAJOR)"
    exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
    err "Node.js v$NODE_MAJOR found, requires >= v$NODE_MIN_MAJOR"
    err "Update: https://nodejs.org/"
    exit 1
fi
ok "Node.js $(node --version)"

# --- Step 2: Check/install whistle ---
info "Checking whistle..."
if ! command -v w2 &>/dev/null; then
    info "whistle not found. Installing..."
    npm install -g whistle || { err "Failed to install whistle"; exit 1; }
    ok "whistle installed"
else
    W2_VERSION=$(w2 --version 2>/dev/null | head -1)
    W2_OK=$(node -e "
        const cur = '$W2_VERSION'.split('.').map(Number);
        const min = '$WHISTLE_MIN'.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if ((cur[i]||0) > (min[i]||0)) { console.log('ok'); process.exit(0); }
            if ((cur[i]||0) < (min[i]||0)) { console.log('low'); process.exit(0); }
        }
        console.log('ok');
    " 2>/dev/null || echo "unknown")
    if [ "$W2_OK" = "low" ]; then
        err "whistle $W2_VERSION found, requires >= $WHISTLE_MIN"
        err "Update: npm i -g whistle"
        exit 1
    fi
    ok "whistle $W2_VERSION"
fi

# --- Step 3: Install plugin dependencies + build ---
info "Building plugin..."
cd "$PLUGIN_DIR"
npm install --silent || { err "npm install failed"; exit 1; }
npx tsc || { err "TypeScript build failed"; exit 1; }
ok "Plugin built"

# --- Step 4: Register plugin + add pipe rule ---
info "Registering whistle.pbmockx plugin..."
w2 install "$PLUGIN_DIR" 2>/dev/null || true
ok "Plugin registered"

# Add pipe rule to whistle (enables decode→patch→encode for all requests)
info "Adding pipe rule to whistle..."
PIPE_JS="/tmp/.pbmockx-pipe.js"
cat > "$PIPE_JS" << 'PIPEOF'
exports.name = 'pbmockx-pipe';
exports.rules = '* pipe://pbmockx';
PIPEOF
w2 add "$PIPE_JS" --force 2>/dev/null && ok "Pipe rule added (* pipe://pbmockx)" || warn "Failed to add pipe rule. Add manually: * pipe://pbmockx"
rm -f "$PIPE_JS"

info "Start with: w2 start -A $PLUGIN_DIR"

# --- Step 5: npm link for short command ---
info "Setting up pbmockx command..."
cd "$PLUGIN_DIR"
npm link --silent 2>/dev/null || warn "npm link failed (may need sudo). Use: w2 exec pbmockx"
if command -v pbmockx &>/dev/null; then
    ok "pbmockx command available"
else
    warn "pbmockx not in PATH. Use: w2 exec pbmockx <command>"
fi

# --- Step 6: Install skill ---
info "Installing SKILL.md for agents..."
node "$PLUGIN_DIR/bin/cli.js" skill install 2>/dev/null || warn "Skill install failed (run: pbmockx skill install)"

# --- Done ---
echo ""
ok "pbmockx v$(cat "$PROJECT_ROOT/VERSION") installed successfully!"
echo ""
info "Next steps:"
echo "  1. Start whistle:       w2 start -A $PLUGIN_DIR"
echo "  2. Install PC cert:     w2 ca"
echo "  3. Check health:        pbmockx doctor"
echo "  4. View docs:           pbmockx agent-doc"
echo ""
info "Android: pbmockx connect-android"
