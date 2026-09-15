#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$root/packages/web/scripts/cloud-web-start.sh" --workspace "$@"
