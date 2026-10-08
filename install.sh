#!/bin/sh
# Install claude-discord-sync on Linux or macOS, then run its setup:
#   curl -fsSL https://raw.githubusercontent.com/Cnyn0403/claude-discord-sync/master/install.sh | sh
# A specific release:  ... | CDS_VERSION=v0.2.0 sh
# (CDS_BASE_URL overrides the download location and CDS_NO_SETUP=1 skips setup; both are for testing.)
set -eu

REPO=Cnyn0403/claude-discord-sync
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported OS: $(uname -s). On Windows use install.ps1." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

asset="claude-discord-sync-$os-$arch"
if [ -n "${CDS_BASE_URL:-}" ]; then
  base="$CDS_BASE_URL"
elif [ -n "${CDS_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$CDS_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi
dir="$HOME/.local/share/claude-discord-sync"
bin="$HOME/.local/bin"
mkdir -p "$dir" "$bin"

echo "Downloading $asset…"
curl -fL --progress-bar "$base/$asset" -o "$dir/claude-discord-sync.new"
expected="$(curl -fsSL "$base/SHA256SUMS" | awk -v a="$asset" '$2 == a { print $1 }')"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$dir/claude-discord-sync.new" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$dir/claude-discord-sync.new" | awk '{ print $1 }')"
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  rm -f "$dir/claude-discord-sync.new"
  echo "Checksum mismatch for $asset; aborting." >&2
  exit 1
fi
chmod +x "$dir/claude-discord-sync.new"
# mv replaces the file even while an older version is running.
mv -f "$dir/claude-discord-sync.new" "$dir/claude-discord-sync"
ln -sf "$dir/claude-discord-sync" "$bin/claude-discord-sync"
echo "Installed $bin/claude-discord-sync"

# Piped into sh, our stdin is this script; give setup the terminal instead.
if [ -n "${CDS_NO_SETUP:-}" ]; then
  echo "Now run: claude-discord-sync setup"
elif [ -r /dev/tty ]; then
  "$dir/claude-discord-sync" setup </dev/tty
else
  echo "Now run: claude-discord-sync setup"
fi
