#!/usr/bin/env bash
# Install a pinned Deno on a Linux x86_64 GitHub runner, from Deno's own
# GitHub release, checking its published SHA-256. Used instead of
# denoland/setup-deno because this repository allows GitHub-owned actions
# only. Adds deno to GITHUB_PATH for the following steps.
#
#   scripts/install-deno.sh [VERSION]    (default 2.9.8)
set -euo pipefail

VERSION="${1:-2.9.8}"
ASSET="deno-x86_64-unknown-linux-gnu.zip"
BASE="https://github.com/denoland/deno/releases/download/v${VERSION}"
DIR="${RUNNER_TEMP:-/tmp}/deno-${VERSION}"

mkdir -p "$DIR/bin"
cd "$DIR"
curl -fsSLO "$BASE/$ASSET"
curl -fsSLO "$BASE/$ASSET.sha256sum"
sha256sum -c "$ASSET.sha256sum"
unzip -oq "$ASSET" -d bin
"$DIR/bin/deno" --version
if [ -n "${GITHUB_PATH:-}" ]; then echo "$DIR/bin" >> "$GITHUB_PATH"; fi
