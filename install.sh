#!/usr/bin/env bash
#
# cc-copilot bootstrap installer (macOS / Linux)
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/cc-copilot/main/install.sh | bash
#
# Clones (or updates) the repo, installs dependencies, links the `cc-copilot`
# CLI, then runs auth + install.
set -euo pipefail

REPO_URL="${CC_COPILOT_REPO:-git@github.com:samehkamaleldin/cc-copilot.git}"
INSTALL_DIR="${CC_COPILOT_HOME:-$HOME/.cc-copilot/app}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node (>=20) is required. Install from https://nodejs.org"
command -v git  >/dev/null 2>&1 || die "git is required."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found $(node -v))."

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating cc-copilot in $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning cc-copilot into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

info "Installing dependencies"
( cd "$INSTALL_DIR" && npm install --omit=dev --no-fund --no-audit )

# Link the CLI onto PATH.
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/cli.mjs" "$BIN_DIR/cc-copilot"
chmod +x "$INSTALL_DIR/bin/cli.mjs"
info "Linked CLI -> $BIN_DIR/cc-copilot"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) info "Add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

cat <<EOF

cc-copilot installed.

Next steps:
  cc-copilot auth        # one-time GitHub Copilot login
  cc-copilot install     # configure Claude Code + start the service

Then just run:  claude
EOF
