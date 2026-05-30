#!/usr/bin/env bash
set -euo pipefail
API_URL="${API_URL:-http://localhost:8080}"
echo "Checking $API_URL/health"
curl -fsS "$API_URL/health" >/dev/null
echo "Checking $API_URL/ready"
curl -fsS "$API_URL/ready" >/dev/null
echo "Checking $API_URL/metrics"
curl -fsS "$API_URL/metrics" | head -20
echo "Production checks passed."
