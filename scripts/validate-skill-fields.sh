#!/usr/bin/env bash
# Validate the pact-network skill stays in sync with the actual SDK surface.
#
# Greps every field name in PactConfig + PactInsuranceConfig out of the
# TypeScript sources, then verifies each one appears somewhere under
# .claude/skills/pact-network/. Fails non-zero if any field is missing.
#
# Run locally before editing the SDK:
#   ./scripts/validate-skill-fields.sh
#
# Also runs in CI for every PR that touches the SDK types or the skill.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$ROOT/.claude/skills/pact-network"

declare -a FILES=(
  "packages/monitor/src/types.ts::PactConfig"
  "packages/insurance/src/types.ts::PactInsuranceConfig"
)

fail=0
for entry in "${FILES[@]}"; do
  file="${entry%%::*}"
  iface="${entry##*::}"

  # Extract the interface body and grab field names (one per optional/required line).
  fields=$(awk "/^export interface $iface/,/^}/" "$ROOT/$file" \
    | grep -E '^[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*\??:' \
    | sed -E 's/^[[:space:]]+([a-zA-Z_][a-zA-Z0-9_]*)\??:.*/\1/')

  if [ -z "$fields" ]; then
    echo "ERROR: could not extract fields from $file::$iface" >&2
    fail=1
    continue
  fi

  while IFS= read -r field; do
    if ! grep -qr "\b$field\b" "$SKILL_DIR" 2>/dev/null; then
      echo "MISSING: $iface.$field not documented in $SKILL_DIR"
      fail=1
    fi
  done <<< "$fields"
done

if [ "$fail" -eq 0 ]; then
  echo "OK: all PactConfig + PactInsuranceConfig fields are referenced in the skill."
fi
exit "$fail"
