#!/usr/bin/env bash
set -euo pipefail

# pbmockx install.sh — native proxy + mock + web UI.
#
# Usage:
#   One-line:   sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"
#   Branch:     PBMOCKX_REF=<branch> sh -c "$(curl -fsSL .../<branch>/scripts/install.sh)"
#   Local:      ./scripts/install.sh
#   Update:     ./scripts/install.sh --update [--ref <branch>]
#   Uninstall:  ./scripts/install.sh --uninstall [--purge]
#
# Layout:
#   install dir: ~/.pbmockx/app        (code; PBMOCKX_INSTALL_DIR overrides)
#   data dir:    ~/.pbmockx            (rules.yaml, mock-data, ca, logs)
#
# No whistle is installed or required. The script does replace an existing
# global `pbmockx` link that points at the old whistle.pbmockx plugin.

REPO_URL="${PBMOCKX_REPO_URL:-https://github.com/zztmercury/pbmockx.git}"
INSTALL_DIR_DEFAULT="${PBMOCKX_INSTALL_DIR:-$HOME/.pbmockx/app}"
DATA_DIR_DEFAULT="${PBMOCKX_DATA_DIR:-$HOME/.pbmockx}"
REF="${PBMOCKX_REF:-main}"

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
        --ref)       [ $# -ge 2 ] || { err "--ref requires a branch"; exit 1; }; REF="$2"; shift 2 ;;
        --yes|-y)    shift ;;
        --help|-h)
            echo "Usage: install.sh [--update] [--uninstall [--purge]] [--ref <branch>] [--yes]"
            exit 0
            ;;
        *)           err "Unknown option: $1"; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd 2>/dev/null)" || ""
PROJECT_ROOT=""
LOCAL_INSTALL=0

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../package.json" ] && [ -f "$SCRIPT_DIR/../VERSION" ]; then
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    LOCAL_INSTALL=1
    if [ "$REF" != "main" ]; then
        warn "Local checkout detected; ignoring --ref $REF and using $PROJECT_ROOT"
    fi
else
    if ! command -v git >/dev/null 2>&1; then
        err "git not found (required for a remote install)"
        exit 1
    fi
    PROJECT_ROOT="$INSTALL_DIR_DEFAULT"

    if [ $UNINSTALL -eq 1 ]; then
        [ -d "$PROJECT_ROOT" ] || warn "No pbmockx checkout at $PROJECT_ROOT"
    elif [ -d "$PROJECT_ROOT/.git" ]; then
        info "Updating pbmockx ($REF) at $PROJECT_ROOT..."
        git -C "$PROJECT_ROOT" fetch --quiet origin "$REF" || { err "Cannot fetch branch $REF"; exit 1; }
        git -C "$PROJECT_ROOT" checkout --quiet "$REF" || { err "Cannot checkout $REF"; exit 1; }
        git -C "$PROJECT_ROOT" merge --ff-only --quiet "origin/$REF" || warn "Could not fast-forward (local changes?); using the current checkout"
    elif [ -e "$PROJECT_ROOT" ]; then
        err "$PROJECT_ROOT already exists but is not a git checkout."
        err "Remove it or set PBMOCKX_INSTALL_DIR to a different directory."
        exit 1
    else
        info "Cloning pbmockx ($REF) to $PROJECT_ROOT..."
        mkdir -p "$(dirname "$PROJECT_ROOT")"
        git clone --quiet --branch "$REF" "$REPO_URL" "$PROJECT_ROOT" || { err "git clone ($REF) failed"; exit 1; }
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
if ! npm install --no-audit --no-fund; then
    err "npm install failed"
    exit 1
fi
if ! npm run build; then
    err "TypeScript build failed"
    exit 1
fi
ok "Build complete"

# --- Step 3: npm link (replace the old whistle-plugin link) ---
OLD_PB="$(command -v pbmockx 2>/dev/null || true)"
if [ -n "$OLD_PB" ] && printf '%s' "$OLD_PB" | grep -q 'whistle.pbmockx'; then
    warn "Replacing the old whistle-plugin global link ($OLD_PB)"
    npm unlink -g whistle.pbmockx >/dev/null 2>&1 || true
fi
info "Linking pbmockx command..."
if npm link --silent 2>/dev/null; then
    ok "pbmockx linked -> $(command -v pbmockx 2>/dev/null || echo "$PROJECT_ROOT/bin/pbmockx.js")"
else
    warn "npm link failed (may need sudo); use: node $PROJECT_ROOT/bin/pbmockx.js <cmd>"
fi

# --- Step 4: agent skill ---
info "Installing SKILL.md for agents..."
node "$PROJECT_ROOT/bin/pbmockx.js" skill install >/dev/null 2>&1 || warn "Skill install failed (run: pbmockx skill install)"

# --- Step 5: verify CLI version + start daemon ---
INSTALLED_VERSION="$(node "$PROJECT_ROOT/bin/pbmockx.js" version 2>/dev/null | head -1 | awk '{print $2}')"
if [ -n "$INSTALLED_VERSION" ]; then
    ok "CLI version $INSTALLED_VERSION"
else
    warn "Could not read the CLI version from $PROJECT_ROOT"
fi

info "Starting pbmockx daemon..."
STARTED=0
if command -v pbmockx >/dev/null 2>&1 && pbmockx restart >/dev/null 2>&1; then
    STARTED=1
elif node "$PROJECT_ROOT/bin/pbmockx.js" restart >/dev/null 2>&1; then
    STARTED=1
fi
if [ $STARTED -eq 1 ]; then
    ok "Daemon started"
else
    warn "Could not start the daemon (check port ${PBMOCKX_PORT:-8899})."
    if command -v w2 >/dev/null 2>&1; then
        warn "Old whistle may still own port 8899: run 'w2 stop', or use PBMOCKX_PORT=8900 ./scripts/install.sh"
    fi
    pbmockx logs -n 20 2>/dev/null || node "$PROJECT_ROOT/bin/pbmockx.js" logs -n 20 2>/dev/null || true
fi

echo ""
ok "pbmockx v$(cat "$PROJECT_ROOT/VERSION") installed"
echo ""
info "Next steps:"
echo "  1. Install the CA on this machine:  pbmockx ca"
echo "  2. Point your HTTP/HTTPS proxy at: 127.0.0.1:${PBMOCKX_PORT:-8899}"
echo "  3. Open the Web UI:                 pbmockx web"
echo "  4. Health check:                    pbmockx doctor"
echo ""
info "LAN devices (phone/another computer):"
echo "  1. pbmockx restart --lan"
echo "  2. Use the LAN IP printed in the output for the proxy and the UI"
echo "  3. Android Wi-Fi: pbmockx connect-android --wifi"
info "Data directory: $DATA_DIR_DEFAULT"
info "If 'pbmockx' still points at the old whistle plugin, run: hash -r"
