#!/usr/bin/env bash
set -euo pipefail

# pbmockx install.sh — oh-my-zsh style one-line installer
#
# Usage:
#   One-line:  sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"
#   Local:     ./scripts/install.sh
#   Update:    ./install.sh --update
#   Uninstall: ./install.sh --uninstall
#
# This script ONLY deploys the CLI tool (venv + symlink + PATH).
# Skill installation is handled by: pbmockx skill install

REPO_URL="https://github.com/zztmercury/pbmockx.git"
REPO_RAW="https://raw.githubusercontent.com/zztmercury/pbmockx/main"
INSTALL_DIR_DEFAULT="$HOME/.pbmockx"
PYTHON_MIN_MAJOR=3
PYTHON_MIN_MINOR=10

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
PREFIX=""
PYTHON_OVERRIDE=""
YES=0
PURGE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --update)    UPDATE=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --purge)     PURGE=1; shift ;;
        --prefix)    PREFIX="$2"; shift 2 ;;
        --python)    PYTHON_OVERRIDE="$2"; shift 2 ;;
        --yes|-y)    YES=1; shift ;;
        --help|-h)   echo "Usage: install.sh [--update] [--uninstall] [--purge] [--prefix <dir>] [--python <path>] [--yes]"; exit 0 ;;
        *)           err "Unknown option: $1"; exit 1 ;;
    esac
done

# --- Banner ---
echo
printf "${BOLD}  pbmockx${NC} — capture & mock protobuf/JSON via mitmproxy\n"
printf "  AI agent friendly CLI + skill, Charles-style map local/remote/breakpoint\n"
echo

# --- Uninstall ---
if [ $UNINSTALL -eq 1 ]; then
    info "Uninstalling pbmockx..."
    # Remove CLI symlinks
    for d in "$HOME/.local/bin" "$HOME/bin" "$HOME/.bun/bin" "/usr/local/bin"; do
        if [ -L "$d/pbmockx" ]; then
            rm -f "$d/pbmockx"
            ok "Removed symlink: $d/pbmockx"
        fi
    done
    # Remove skill symlinks (legacy + current)
    for sd in "$HOME/.agents/skills/pbmockx" "$HOME/.agents/skills/mitmproxy-mock" "$HOME/.claude/skills/pbmockx" "$HOME/.config/opencode/skills/pbmockx"; do
        if [ -L "$sd/SKILL.md" ]; then
            rm -f "$sd/SKILL.md"
            rmdir "$sd" 2>/dev/null || true
            ok "Removed skill: $sd"
        fi
    done
    if [ $PURGE -eq 1 ]; then
        rm -rf "$INSTALL_DIR_DEFAULT"
        ok "Purged $INSTALL_DIR_DEFAULT"
    else
        info "Project directory preserved at $INSTALL_DIR_DEFAULT (use --purge to delete)"
    fi
    ok "Uninstall complete."
    exit 0
fi

# --- Determine script_dir (local vs remote mode) ---
SCRIPT_DIR=""
if [ -f "addon/pbmockx_addon.py" ] && [ -f "bin/pbmockx" ]; then
    SCRIPT_DIR="$(pwd)"
elif [ -n "${0:-}" ] && [ -f "$(dirname "$0" 2>/dev/null)/../addon/pbmockx_addon.py" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fi

if [ -z "$SCRIPT_DIR" ]; then
    # Remote mode: clone/update
    SCRIPT_DIR="${PBMOCKX_HOME:-$INSTALL_DIR_DEFAULT}"
    if [ -d "$SCRIPT_DIR/.git" ]; then
        info "Updating pbmockx at $SCRIPT_DIR..."
        git -C "$SCRIPT_DIR" pull --ff-only
    else
        info "Cloning pbmockx to $SCRIPT_DIR..."
        git clone "$REPO_URL" "$SCRIPT_DIR"
    fi
fi

cd "$SCRIPT_DIR"

if [ ! -f "bin/pbmockx" ] || [ ! -f "addon/pbmockx_addon.py" ]; then
    err "bin/pbmockx or addon/pbmockx_addon.py not found in $SCRIPT_DIR"
    err "This doesn't look like a pbmockx project directory."
    exit 1
fi

# --- Find Python 3.10+ ---
find_python() {
    if [ -n "$PYTHON_OVERRIDE" ]; then
        if command -v "$PYTHON_OVERRIDE" >/dev/null 2>&1; then
            echo "$PYTHON_OVERRIDE"
            return 0
        fi
        return 1
    fi
    for cmd in python3.13 python3.12 python3.11 python3.10 python3; do
        if command -v "$cmd" >/dev/null 2>&1; then
            ver=$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null) || continue
            major="${ver%%.*}"
            minor="${ver#*.}"
            if [ "$major" -ge "$PYTHON_MIN_MAJOR" ] 2>/dev/null && [ "$minor" -ge "$PYTHON_MIN_MINOR" ] 2>/dev/null; then
                echo "$cmd"
                return 0
            fi
        fi
    done
    return 1
}

PYTHON=$(find_python) || {
    err "Python >= ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR} not found."
    echo ""
    echo "  macOS:  brew install python@3.13"
    echo "  Ubuntu: sudo apt install python3.12"
    echo "  Fedora: sudo dnf install python3.12"
    echo "  conda:  conda install python=3.12"
    echo ""
    echo "  Or specify path: install.sh --python /path/to/python3.13"
    exit 1
}

info "Python: $($PYTHON --version)"

# --- venv ---
VENV="$SCRIPT_DIR/.venv"
if [ ! -x "$VENV/bin/python" ]; then
    info "Creating venv at $VENV..."
    "$PYTHON" -m venv "$VENV"
fi

info "Installing dependencies..."
"$VENV/bin/pip" install -q --upgrade pip
if [ $UPDATE -eq 1 ]; then
    "$VENV/bin/pip" install -q --upgrade mitmproxy protobuf requests
else
    "$VENV/bin/pip" install -q mitmproxy protobuf requests
fi
ok "Dependencies installed"

# --- Find writable PATH directory for CLI symlink ---
find_prefix() {
    if [ -n "$PREFIX" ]; then
        echo "$PREFIX"
        return 0
    fi
    IFS=':' read -ra DIRS <<< "$PATH"
    for d in "${DIRS[@]}"; do
        [ -d "$d" ] || continue
        [ -w "$d" ] || continue
        # Skip system dirs and hidden tool dirs (.bun, .cargo, .jenv, .proto, etc.)
        case "$d" in
            /usr/bin|/bin|/usr/sbin|/sbin|/System/*) continue ;;
            */.*/bin|*/.*/bin/*) continue ;;
        esac
        echo "$d"
        return 0
    done
    return 1
}

PREFIX=$(find_prefix)
if [ -z "$PREFIX" ]; then
    PREFIX="$HOME/.local/bin"
fi
mkdir -p "$PREFIX"

ln -sf "$SCRIPT_DIR/bin/pbmockx" "$PREFIX/pbmockx"
chmod +x "$SCRIPT_DIR/bin/pbmockx"
ok "CLI installed → $PREFIX/pbmockx"

# --- PATH check + interactive shell config ---
in_path() {
    case ":$PATH:" in
        *":$1:"*) return 0 ;;
        *)        return 1 ;;
    esac
}

if ! in_path "$PREFIX"; then
    echo
    warn "$PREFIX is not in your PATH."

    if [ $YES -eq 1 ]; then
        ANSWER="y"
    else
        read -p "  Add to shell config automatically? (Y/n) " ANSWER
        ANSWER=${ANSWER:-y}
    fi

    case "$ANSWER" in
        y|Y)
            CURRENT_SHELL=$(basename "${SHELL:-}")
            # Use $HOME variable if PREFIX is under home, for portability
            PREFIX_DISPLAY="$PREFIX"
            case "$PREFIX" in
                "$HOME"/*)
                    remainder="${PREFIX#$HOME}"
                    PREFIX_DISPLAY="\$HOME$remainder"
                    ;;
            esac
            case "$CURRENT_SHELL" in
                zsh)
                    RCFILE="$HOME/.zshrc"
                    LINE="export PATH=\"${PREFIX_DISPLAY}:\$PATH\""
                    ;;
                bash)
                    if [ "$(uname)" = "Darwin" ]; then
                        RCFILE="$HOME/.bash_profile"
                    else
                        RCFILE="$HOME/.bashrc"
                    fi
                    LINE="export PATH=\"${PREFIX_DISPLAY}:\$PATH\""
                    ;;
                fish)
                    RCFILE="$HOME/.config/fish/config.fish"
                    LINE="fish_add_path $PREFIX"
                    ;;
                *)
                    warn "Unknown shell: $CURRENT_SHELL. Please add $PREFIX to PATH manually."
                    RCFILE=""
                    ;;
            esac

            if [ -n "$RCFILE" ]; then
                mkdir -p "$(dirname "$RCFILE")"
                touch "$RCFILE"
                # Check if PREFIX basename already in RCFILE
                PREFIX_BASE=$(basename "$PREFIX")
                if grep -qF "$PREFIX_BASE" "$RCFILE" 2>/dev/null; then
                    info "$RCFILE already has $PREFIX_BASE, skipping."
                else
                    cp "$RCFILE" "${RCFILE}.bak" 2>/dev/null || true
                    echo "" >> "$RCFILE"
                    echo "# Added by pbmockx install" >> "$RCFILE"
                    echo "$LINE" >> "$RCFILE"
                    ok "Added PATH to $RCFILE (backup: ${RCFILE}.bak)"
                    info "Open a new terminal or run: source $RCFILE"
                fi
            fi
            ;;
        n|N)
            info "Skipped. Add $PREFIX to PATH manually to use pbmockx command."
            ;;
    esac
fi

# --- Verify ---
if in_path "$PREFIX"; then
    if "$PREFIX/pbmockx" agent-doc >/dev/null 2>&1; then
        ok "Verification passed — pbmockx CLI is ready."
    else
        warn "CLI symlink works but agent-doc failed. Check $SCRIPT_DIR/SKILL.md exists."
    fi
else
    info "Verify with: $PREFIX/pbmockx agent-doc"
fi

# --- Summary ---
echo
printf "${GREEN}${BOLD}  Installation complete!${NC}\n"
echo
echo "  CLI:      $PREFIX/pbmockx"
echo "  Project:  $SCRIPT_DIR"
echo "  Venv:     $VENV"
echo
printf "  ${BOLD}Next steps:${NC}\n"
echo "    1. Start proxy:     pbmockx start"
echo "    2. Install skill:  pbmockx skill install"
echo "    3. Check health:   pbmockx doctor"
echo
