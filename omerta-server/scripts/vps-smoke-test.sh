#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${PUBLIC_API_URL:-}"
if [ -f .env ]; then
  BASE_URL="$(grep -E '^PUBLIC_API_URL=' .env | head -1 | cut -d= -f2- || true)"
fi
BASE_URL="${BASE_URL:-http://127.0.0.1}"

echo "Testing ${BASE_URL}"
for path in /health /ready; do
  code="$(curl -fsS -o /tmp/omerta-smoke.out -w '%{http_code}' "${BASE_URL}${path}" || true)"
  if [ "$code" != "200" ]; then
    echo "Smoke test failed: ${path} returned ${code}"
    cat /tmp/omerta-smoke.out 2>/dev/null || true
    exit 1
  fi
  echo "OK ${path}"
done

echo "VPS smoke test OK."
