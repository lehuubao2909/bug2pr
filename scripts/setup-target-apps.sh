#!/usr/bin/env bash
# Clones the two target apps next to this repo and recreates the eval bug branches:
#   shadcn-admin: pinned upstream commit + one seeded bug per eval/bugs/shadcn-*/bug.patch
#   actual:       the upstream commit just before the real fix for issue #8475
# Safe to re-run: existing clones and branches are kept.
#
# Usage: npm run setup:targets            (TARGETS_DIR defaults to ../targets)
#        npm run setup:targets -- shadcn  (only shadcn-admin; Actual is a large monorepo)
set -euo pipefail

cd "$(dirname "$0")/.."
TARGETS_DIR="$(mkdir -p "${TARGETS_DIR:-../targets}" && cd "${TARGETS_DIR:-../targets}" && pwd)"
ONLY="${1:-all}"

SHADCN_REPO=https://github.com/satnaing/shadcn-admin.git
SHADCN_BASE=e16c87f213a5ba5e45964e9b67c792105ec74d26
ACTUAL_REPO=https://github.com/actualbudget/actual.git
ACTUAL_BUG_COMMIT=501bece3a1a556b9538359ca3284d065bac285eb # parent of fix PR #8490

# Patches are applied with a fixed identity so the script never depends on the user's git config.
git_bot() { git -c user.name=bug2pr -c user.email=bug2pr@localhost "$@"; }
branch_of() { node -p "require('./eval/bugs/$1/truth.json').branch"; }
has_branch() { git -C "$1" show-ref --verify --quiet "refs/heads/$2"; }

setup_shadcn() {
  local dir="$TARGETS_DIR/shadcn-admin"
  if [ ! -d "$dir/.git" ]; then
    echo "→ cloning shadcn-admin"
    git clone -q "$SHADCN_REPO" "$dir"
    git -C "$dir" checkout -q -B main "$SHADCN_BASE"
  fi
  for patch in eval/bugs/shadcn-*/bug.patch; do
    local id branch
    id="$(basename "$(dirname "$patch")")"
    branch="$(branch_of "$id")"
    if has_branch "$dir" "$branch"; then echo "  ✓ $branch (exists)"; continue; fi
    git -C "$dir" checkout -q -b "$branch" "$SHADCN_BASE"
    git_bot -C "$dir" am -q "$PWD/$patch"
    echo "  ✓ $branch"
  done
  git -C "$dir" checkout -q main
  echo "→ installing shadcn-admin dependencies"
  (cd "$dir" && pnpm install --silent)
}

setup_actual() {
  local dir="$TARGETS_DIR/actual" branch
  branch="$(branch_of actual-8475-running-balance)"
  if [ ! -d "$dir/.git" ]; then
    echo "→ cloning actual (large monorepo, blobless clone)"
    git clone -q --filter=blob:none "$ACTUAL_REPO" "$dir"
  fi
  has_branch "$dir" "$branch" || git -C "$dir" branch "$branch" "$ACTUAL_BUG_COMMIT"
  git -C "$dir" checkout -q "$branch"
  echo "  ✓ $branch"
  echo "→ installing actual dependencies (takes a few minutes)"
  (cd "$dir" && yarn install)
  (cd "$dir/packages/desktop-client" && npx playwright install chromium)
}

case "$ONLY" in
  shadcn) setup_shadcn ;;
  actual) setup_actual ;;
  all) setup_shadcn; setup_actual ;;
  *) echo "usage: setup-target-apps.sh [all|shadcn|actual]" >&2; exit 1 ;;
esac

cat <<EOF

Done. Start the target apps (each in its own terminal):
  npm run target:shadcn    # http://localhost:5173
  npm run target:actual    # http://localhost:3002
Then: npm run ui           # http://localhost:4100
EOF
