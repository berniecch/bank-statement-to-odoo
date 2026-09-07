#!/usr/bin/env bash
# Usage: bash deploy.sh <GITHUB_TOKEN> [repo-name]
# Creates a PUBLIC repo under the token owner, pushes this folder, enables Pages.
set -euo pipefail
TOKEN="${1:?need a GitHub token as arg 1}"
REPO="${2:-bank-statement-to-odoo}"
API="https://api.github.com"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "→ Verifying token…"
USER=$(curl -fsSL -H "Authorization: token $TOKEN" "$API/user" | grep -o '"login":[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$USER" ] || { echo "Could not read user (bad token/scope)"; exit 1; }
echo "  authenticated as: $USER"

echo "→ Creating public repo $USER/$REPO (ok if it already exists)…"
curl -fsSL -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/user/repos" \
  -d "{\"name\":\"$REPO\",\"private\":false,\"description\":\"Convert bank-statement PDFs into an Odoo-ready Excel export — 100% client-side.\",\"homepage\":\"https://$USER.github.io/$REPO/\"}" \
  >/dev/null 2>&1 || echo "  (repo may already exist — continuing)"

echo "→ Pushing code…"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${TOKEN}@github.com/$USER/$REPO.git"
git push -u origin main --force
git remote set-url origin "https://github.com/$USER/$REPO.git"   # strip token from stored remote

echo "→ Enabling GitHub Pages (main / root)…"
curl -fsSL -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/repos/$USER/$REPO/pages" \
  -d '{"source":{"branch":"main","path":"/"}}' >/dev/null 2>&1 \
  || curl -fsSL -X PUT -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
       "$API/repos/$USER/$REPO/pages" \
       -d '{"source":{"branch":"main","path":"/"}}' >/dev/null 2>&1 \
  || echo "  (Pages may already be enabled)"

echo
echo "✅ Done."
echo "   Repo: https://github.com/$USER/$REPO"
echo "   Live (in ~1 min): https://$USER.github.io/$REPO/"
