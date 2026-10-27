#!/usr/bin/env bash
# Builds AV Courier for macOS as a .dmg. Run it ON A MAC (Windows cannot make a .dmg):
#
#   bash scripts/build-mac.sh            # for this Mac (Apple silicon or Intel)
#   bash scripts/build-mac.sh universal  # one .dmg for both (larger)
#   bash scripts/build-mac.sh arm64|x64
#
# Needs Node.js 20 or newer (nodejs.org) and the Xcode command-line tools
# (xcode-select --install). The result lands in dist/. The app is not signed with an
# Apple Developer ID, so the first time, open it with right-click → Open (see the end).
set -euo pipefail
cd "$(dirname "$0")/.."

[[ "$(uname)" == "Darwin" ]] || { echo "Run this on a Mac: a .dmg can only be built on macOS."; exit 1; }
command -v node >/dev/null || { echo "Install Node.js 20 or newer from https://nodejs.org first."; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node.js 20 or newer is needed (found $(node -v))."; exit 1; }
command -v codesign >/dev/null || { echo "Install the Xcode command-line tools first: xcode-select --install"; exit 1; }

ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|x64|universal) ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unknown architecture '$ARCH': use arm64, x64 or universal."; exit 1 ;;
esac
VERSION=$(node -p 'require("./package.json").version')
echo "Building AV Courier $VERSION for macOS ($ARCH)…"

npm ci
npm test

# No Apple Developer ID: build the app unsigned, sign it "ad hoc" (Apple silicon refuses to
# run apps with no signature at all), then wrap that app in the .dmg.
export CSC_IDENTITY_AUTO_DISCOVERY=false
rm -rf dist
npx electron-builder --mac dir --"$ARCH" -c.mac.identity=null --publish never
APP=$(find dist -maxdepth 2 -name "AV Courier.app" -type d | head -n 1)
[[ -n "$APP" ]] || { echo "The app was not built: see the messages above."; exit 1; }
codesign --force --deep --sign - "$APP"
npx electron-builder --mac dmg --"$ARCH" --prepackaged "$APP" -c.mac.identity=null --publish never

DMG=$(ls dist/*.dmg | head -n 1)
echo
echo "Done: $DMG"
echo
echo "Install: open the .dmg and drag AV Courier to Applications. The first time, right-click"
echo "AV Courier in Applications → Open → Open (it is not signed by an Apple developer)."
echo "If macOS says it is damaged, run once:"
echo "  xattr -dr com.apple.quarantine \"/Applications/AV Courier.app\""
