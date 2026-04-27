#!/usr/bin/env bash
# Deploy the pact_insurance program to Solana.
#
# Default: deploys the Pinocchio binary (pact_insurance_pinocchio.so).
# Pass --legacy-anchor to fall back to the Anchor binary (pact_insurance.so).
#
# Usage:
#   ./scripts/deploy.sh [--legacy-anchor] [-- <extra solana program deploy args>]
#
# Environment:
#   PROGRAM_ID   Override program ID (default: 2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3)
#   KEYPAIR      Path to upgrade-authority keypair (default: ~/.config/solana/id.json)
#   RPC_URL      Solana RPC endpoint (default: https://api.devnet.solana.com)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROGRAM_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PINOCCHIO_SO="$PROGRAM_ROOT/target/deploy/pact_insurance_pinocchio.so"
ANCHOR_SO="$PROGRAM_ROOT/target/deploy/pact_insurance.so"

PROGRAM_ID="${PROGRAM_ID:-2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3}"
KEYPAIR="${KEYPAIR:-$HOME/.config/solana/id.json}"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"

USE_LEGACY_ANCHOR=false
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --legacy-anchor)
      USE_LEGACY_ANCHOR=true
      shift
      ;;
    --)
      shift
      EXTRA_ARGS=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ "$USE_LEGACY_ANCHOR" == "true" ]]; then
  SO_PATH="$ANCHOR_SO"
  echo "[deploy] LEGACY ANCHOR fallback — deploying $SO_PATH"
else
  SO_PATH="$PINOCCHIO_SO"
  echo "[deploy] Pinocchio (default) — deploying $SO_PATH"
fi

if [[ ! -f "$SO_PATH" ]]; then
  echo "[deploy] ERROR: binary not found at $SO_PATH"
  if [[ "$USE_LEGACY_ANCHOR" == "true" ]]; then
    echo "  Run: anchor build"
  else
    echo "  Run: cargo build-sbf --manifest-path programs-pinocchio/pact-insurance-pinocchio/Cargo.toml --features bpf-entrypoint"
  fi
  exit 1
fi

echo "[deploy] program-id: $PROGRAM_ID"
echo "[deploy] keypair:    $KEYPAIR"
echo "[deploy] rpc:        $RPC_URL"

solana program deploy \
  --program-id "$PROGRAM_ID" \
  --keypair "$KEYPAIR" \
  --url "$RPC_URL" \
  "${EXTRA_ARGS[@]}" \
  "$SO_PATH"
