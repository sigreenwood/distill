#!/usr/bin/env bash
#
# Install the Plaud Obsidian plugin into a vault by symlinking the built
# package into the vault's plugins directory. Re-run after `npm run build:plugin`
# is unnecessary — the symlink always points at the latest build.
#
# Usage:
#   ./scripts/install-plugin.sh /path/to/vault
#
# Example:
#   ./scripts/install-plugin.sh ~/Documents/SV
#
set -euo pipefail

VAULT="${1:-}"
PLUGIN_ID="obsidian-plaud"

if [[ -z "$VAULT" ]]; then
  echo "Usage: $0 /path/to/vault" >&2
  exit 1
fi
if [[ ! -d "$VAULT/.obsidian" ]]; then
  echo "Error: '$VAULT' does not look like an Obsidian vault (no .obsidian/)." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/obsidian"
DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"

# Build if main.js is missing.
if [[ ! -f "$PKG_DIR/main.js" ]]; then
  echo "Building plugin (main.js missing)..."
  ( cd "$REPO_ROOT" && npm run build:plugin )
fi

mkdir -p "$VAULT/.obsidian/plugins"

# Preserve existing runtime settings (data.json holds syncedIds).
if [[ -e "$DEST" && ! -L "$DEST" && -f "$DEST/data.json" ]]; then
  echo "Preserving existing data.json -> $PKG_DIR/data.json"
  cp "$DEST/data.json" "$PKG_DIR/data.json"
fi

# Replace any existing folder/symlink with a fresh symlink to the package.
rm -rf "$DEST"
ln -s "$PKG_DIR" "$DEST"

echo "Linked $DEST -> $PKG_DIR"
echo "Now enable/reload the '$PLUGIN_ID' plugin in Obsidian."
