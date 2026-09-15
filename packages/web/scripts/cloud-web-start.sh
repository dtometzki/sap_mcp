#!/usr/bin/env bash
# Cloud Agent boot: restore the existing vault from env parts, then start the web app.
# Never print secret values or vault.enc contents.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
# The compatibility wrapper must retain the root entrypoint's .env precedence.
if [ "${1:-}" = "--workspace" ]; then
  cd "$root/../.."
fi

bash "$root/scripts/restore-web-vault.sh"
npm run web:start
