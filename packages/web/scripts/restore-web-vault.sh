#!/usr/bin/env bash
# Restore ~/.sap-notes-web/vault.enc from SAP_WEB_VAULT_B64_1..4.
# Never print secret values or decoded vault bytes.
set -euo pipefail

missing=0
for i in 1 2 3 4; do
  var="SAP_WEB_VAULT_B64_${i}"
  if [ -z "${!var:-}" ]; then
    printf '%s: missing\n' "$var" >&2
    missing=1
  else
    len=$(printf '%s' "${!var}" | wc -c)
    printf '%s: present length=%s\n' "$var" "$len"
  fi
done

if [ "$missing" -ne 0 ]; then
  printf 'Cannot restore vault: one or more SAP_WEB_VAULT_B64_* parts are unset.\n' >&2
  exit 1
fi

dest_dir="${SAP_WEB_DATA_DIR:-$HOME/.sap-notes-web}"
mkdir -p -m 0700 "$dest_dir"
chmod 0700 "$dest_dir"

tmp="$(mktemp)"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

{
  printf '%s' "$SAP_WEB_VAULT_B64_1"
  printf '%s' "$SAP_WEB_VAULT_B64_2"
  printf '%s' "$SAP_WEB_VAULT_B64_3"
  printf '%s' "$SAP_WEB_VAULT_B64_4"
} | base64 -d > "$tmp"

if [ ! -s "$tmp" ]; then
  printf 'Vault decode produced an empty file.\n' >&2
  exit 1
fi

install -m 0600 "$tmp" "$dest_dir/vault.enc"
size=$(wc -c < "$dest_dir/vault.enc" | tr -d '[:space:]')
printf 'vault.enc restored size=%s mode=0600\n' "$size"
