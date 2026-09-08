#!/bin/bash
# Release script for Human OS
# Usage: ./scripts/release.sh [version]
# If no version provided, uses today's date (vYYYY.MM.DD)
#
# IMPORTANT: Release is ONLY manual via GitHub Actions!
# This script just checks prerequisites.

set -e

# --dry-run: sirf report karo, kuch likho/commit mat karo (npm run release:dry)
DRY_RUN=0
if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=1
    shift
fi

# Get version from argument — jo version daloge wohi hoga (manual control).
if [ -n "$1" ]; then
    VERSION="$1"
else
    echo "❌ Release version chahiye (e.g. ./release.sh 2026.09.7004)"
    exit 1
fi

# Ensure version starts with 'v'
if [[ ! "$VERSION" =~ ^v ]]; then
    VERSION="v$VERSION"
fi

echo "🚀 Release Version: $VERSION"
echo ""

# Check if on main branch
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
    echo "❌ You must be on 'main' branch to release!"
    echo "   Current branch: $BRANCH"
    exit 1
fi
echo "✅ On main branch"

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "⚠️  You have uncommitted changes!"
    git status --short
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Pull latest
echo "📥 Pulling latest changes..."
git pull origin main

# Run tests first
echo ""
echo "🧪 Running tests..."
if ! npm run test -- --run; then
    echo "❌ Tests failed! Fix them before releasing."
    exit 1
fi

echo ""
echo "✅ All tests passed!"
echo ""

# ---- Release ke last step: app version ko saari jagah sync karo ----
# package.json (source of truth) + README/manifest/index.html/capacitor me
# stale occurrences — release-version.mjs exact old-string replace karta hai,
# koi funny file nahi todta (src/ kabhi scan nahi hota). Invalid version →
# script exit 1 → set -e se release abort.
echo "🔖 Syncing app version everywhere..."
if [[ "$DRY_RUN" == "1" ]]; then
  VERSION_SYNC="$(node scripts/release-version.mjs --set "$VERSION" --dry-run)"
else
  VERSION_SYNC="$(node scripts/release-version.mjs --set "$VERSION")"
fi
echo "$VERSION_SYNC"

if [[ "$DRY_RUN" == "1" ]]; then
  echo ""
  echo "⏳ DRY RUN — kuch commit nahi hua. Asli release ke liye: npm run release -- \"$VERSION\""
  exit 0
fi

VERSION_FILES="package.json package-lock.json README.md README.EN.md index.html public/manifest.json public/sw.js capacitor.config.ts capacitor.config.json"
DIRTY_VERSION_FILES=$(git status --porcelain -- $VERSION_FILES)
if [ -n "$DIRTY_VERSION_FILES" ]; then
  git add $VERSION_FILES
  git commit -m "chore(release): bump app version to ${VERSION#v}"
  echo "✅ Version bump committed"
else
  echo "ℹ️  No version files changed — version already synced"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 To create release:"
echo ""
echo "   1. Go to GitHub Actions:"
echo "      https://github.com/anurag008w/jee-human-os/actions"
echo ""
echo "   2. Click 'Release' workflow"
echo ""
echo "   3. Click 'Run workflow'"
echo ""
echo "   4. Enter version: $VERSION"
echo ""
echo "   5. Click 'Run workflow'"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Or use GitHub CLI:"
echo "   gh workflow run release.yml -f version=$VERSION"
