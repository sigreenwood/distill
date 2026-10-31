#!/bin/sh
# Publish dist/distill-<version>-arm64.pkg as a GitHub release, which is what
# installed copies check for updates (src/main/updateCheck.ts).
#
#   npm run package            # build the .pkg first
#   git push                   # the tag must point at a pushed commit
#   npm run release [notes.md] # then this
#
# Notes come from docs/app/releases/<version>.md if it exists, else the commit
# subjects since the previous release; they are what users read in the update
# window before deciding to install, so write them for users. A <pkg>.sha256 asset is published too —
# the app refuses to install a download it cannot verify.
set -eu
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": "\([0-9][0-9.]*\)".*/\1/p' package.json | head -1)
NAME="distill-$VERSION-arm64.pkg"
TAG="v$VERSION"
[ -f "dist/$NAME" ] || { echo "dist/$NAME not found. Build it first: npm run package" >&2; exit 1; }

HEAD_SHA=$(git rev-parse HEAD)
if ! git branch -r --contains "$HEAD_SHA" | grep -q .; then
  echo "HEAD ($HEAD_SHA) has not been pushed. Run: git push" >&2; exit 1
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG already exists. Bump the version in package.json and rebuild." >&2; exit 1
fi

NOTES=$(mktemp)
trap 'rm -f "$NOTES"' EXIT
CURATED="../../docs/app/releases/$VERSION.md"
if [ $# -ge 1 ]; then
  cp "$1" "$NOTES"
elif [ -f "$CURATED" ]; then
  cp "$CURATED" "$NOTES"
else
  PREV=$(git describe --tags --abbrev=0 2>/dev/null || true)
  if [ -n "$PREV" ]; then git log --pretty='- %s' "$PREV..HEAD" > "$NOTES"
  else git log --pretty='- %s' -15 > "$NOTES"; fi
fi

( cd dist && shasum -a 256 "$NAME" > "$NAME.sha256" )
gh release create "$TAG" "dist/$NAME" "dist/$NAME.sha256" \
  --title "distill $VERSION" --notes-file "$NOTES" --target "$HEAD_SHA"
echo "Published $TAG. Installed copies will offer it within about 6 hours (or via Check for updates)."
