#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
( cd omerta-core-server && npm run lint )
( cd omerta-creator-dashboard && npm run build )
echo "Dev check complete"
