#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> [1/5] Running offline repository integrity & secret scan (scripts/check-repo.mjs)..."
node scripts/check-repo.mjs "$ROOT_DIR"

echo "==> [2/5] Checking CommonJS host syntax (node --check)..."
node --check host/electron-host.cjs
node --check host/chrome-preload.cjs

echo "==> [3/5] Running TypeScript typecheck (pnpm typecheck)..."
pnpm typecheck

echo "==> [4/5] Building TypeScript dist output (pnpm build)..."
pnpm build

if [[ "${1:-}" == "--full" ]]; then
  echo "==> [5/5] Running full test suite including CDP E2E (pnpm test)..."
  pnpm test
else
  echo "==> [5/5] Running unit test suite (pnpm test:unit)..."
  pnpm test:unit
fi

echo "==> [verify] All checks passed!"
