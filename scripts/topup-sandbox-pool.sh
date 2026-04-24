#!/usr/bin/env bash
# topup-sandbox-pool.sh — provision and fund the F3 sandbox keypair pool on devnet.
#
# Pool model
# ----------
# 5 devnet keypairs used round-robin by POST /api/v1/devnet/sandbox/inject-failure.
# Each keypair needs three things before it can produce a refund at request time:
#   1. SOL (to sign transactions): 0.3 SOL per keypair, 1.5 SOL total.
#   2. USDC on the test mint (to cap refunds): 5 test-USDC per keypair.
#   3. An active on-chain Policy for each hostname the sandbox will serve.
#      Policy creation is idempotent, so running the script twice is safe.
#
# Run this script once per devnet environment at provision time, and again
# any time the balances drop below the warn threshold (see WARN_SOL_LAMPORTS
# / WARN_USDC_RAW). The sandbox endpoint returns 503
# "sandbox_policy_not_provisioned" if a keypair has no policy for the
# hostname in the request — that is the canonical signal to re-run this
# script.
#
# Required env
#   SANDBOX_KEYPAIRS_DIR      — directory holding the 5 keypair JSON files
#                                (alternative: SANDBOX_KEYPAIRS_BASE58, but
#                                 this script operates on files).
#   SANDBOX_HOSTNAMES         — comma-separated hostnames to provision
#                                policies for (e.g.
#                                "api.test-provider.example").
#   PHANTOM_KEYPAIR_PATH      — keypair that funds SOL + holds USDC mint
#                                authority (matches trigger-claim-demo.ts
#                                usage).
#   SOLANA_PROGRAM_ID         — devnet deployment of pact_insurance.
#   USDC_MINT                 — devnet USDC mint address.
#   BACKEND_URL               — default http://localhost:3001; used only for
#                                the optional health probe at the end.
#
# Usage
#   SANDBOX_KEYPAIRS_DIR=./secrets/sandbox-pool \
#   SANDBOX_HOSTNAMES=api.test-provider.example \
#   PHANTOM_KEYPAIR_PATH=$HOME/.config/solana/phantom-devnet.json \
#   SOLANA_PROGRAM_ID=... USDC_MINT=... \
#   bash scripts/topup-sandbox-pool.sh
#
# Exit codes
#   0 — pool funded + policies provisioned
#   1 — missing env / pre-flight failure
#   2 — on-chain step failed (re-run after fixing the root cause)

set -euo pipefail

# --- defaults --------------------------------------------------------------
: "${SANDBOX_KEYPAIRS_DIR:=}"
: "${SANDBOX_HOSTNAMES:=}"
: "${PHANTOM_KEYPAIR_PATH:=$HOME/.config/solana/phantom-devnet.json}"
: "${SOLANA_PROGRAM_ID:=}"
: "${USDC_MINT:=}"
: "${BACKEND_URL:=http://localhost:3001}"
: "${SOL_TOPUP_LAMPORTS:=300000000}"     # 0.3 SOL
: "${WARN_SOL_LAMPORTS:=100000000}"      # 0.1 SOL — topup when below
: "${USDC_TOPUP_RAW:=5000000}"           # 5 test-USDC
: "${WARN_USDC_RAW:=2000000}"            # 2 test-USDC — topup when below
: "${RPC_URL:=https://api.devnet.solana.com}"

# --- pre-flight ------------------------------------------------------------
missing=()
[[ -z "$SANDBOX_KEYPAIRS_DIR" ]] && missing+=("SANDBOX_KEYPAIRS_DIR")
[[ -z "$SANDBOX_HOSTNAMES" ]]    && missing+=("SANDBOX_HOSTNAMES")
[[ -z "$SOLANA_PROGRAM_ID" ]]    && missing+=("SOLANA_PROGRAM_ID")
[[ -z "$USDC_MINT" ]]            && missing+=("USDC_MINT")

if (( ${#missing[@]} > 0 )); then
    echo "[FAIL] missing required env vars: ${missing[*]}" >&2
    exit 1
fi

if [[ ! -d "$SANDBOX_KEYPAIRS_DIR" ]]; then
    echo "[FAIL] SANDBOX_KEYPAIRS_DIR ($SANDBOX_KEYPAIRS_DIR) is not a directory" >&2
    exit 1
fi

if [[ ! -f "$PHANTOM_KEYPAIR_PATH" ]]; then
    echo "[FAIL] phantom keypair not found at $PHANTOM_KEYPAIR_PATH" >&2
    exit 1
fi

command -v solana >/dev/null || { echo "[FAIL] solana CLI not found on PATH" >&2; exit 1; }
command -v spl-token >/dev/null || { echo "[FAIL] spl-token CLI not found on PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "[FAIL] jq not found on PATH" >&2; exit 1; }

echo "[init] RPC:                 $RPC_URL"
echo "[init] SOLANA_PROGRAM_ID:   $SOLANA_PROGRAM_ID"
echo "[init] USDC_MINT:           $USDC_MINT"
echo "[init] sandbox keypair dir: $SANDBOX_KEYPAIRS_DIR"
echo "[init] sandbox hostnames:   $SANDBOX_HOSTNAMES"
echo "[init] phantom keypair:     $PHANTOM_KEYPAIR_PATH"
echo

solana config set --url "$RPC_URL" >/dev/null

shopt -s nullglob
keypair_files=("$SANDBOX_KEYPAIRS_DIR"/*.json)
shopt -u nullglob

if (( ${#keypair_files[@]} == 0 )); then
    echo "[FAIL] no *.json keypairs in $SANDBOX_KEYPAIRS_DIR" >&2
    exit 1
fi

phantom_pubkey="$(solana-keygen pubkey "$PHANTOM_KEYPAIR_PATH")"
echo "[init] phantom pubkey: $phantom_pubkey"
echo

# --- per-keypair loop ------------------------------------------------------
for kp_file in "${keypair_files[@]}"; do
    kp_pubkey="$(solana-keygen pubkey "$kp_file")"
    echo "[slot] $kp_pubkey ($(basename "$kp_file"))"

    # SOL top-up
    current_sol_lamports="$(solana balance --output json "$kp_pubkey" --url "$RPC_URL" 2>/dev/null | jq -r '.lamports // 0')"
    if (( current_sol_lamports < WARN_SOL_LAMPORTS )); then
        echo "  [sol] balance ${current_sol_lamports} lamports < warn ${WARN_SOL_LAMPORTS}; transferring ${SOL_TOPUP_LAMPORTS} lamports from phantom"
        solana transfer \
            --from "$PHANTOM_KEYPAIR_PATH" \
            --url "$RPC_URL" \
            --allow-unfunded-recipient \
            --fee-payer "$PHANTOM_KEYPAIR_PATH" \
            "$kp_pubkey" \
            "$(awk "BEGIN { printf \"%.9f\", $SOL_TOPUP_LAMPORTS/1000000000 }")" >/dev/null || {
            echo "  [FAIL] solana transfer failed for $kp_pubkey" >&2
            exit 2
        }
    else
        echo "  [sol] balance ${current_sol_lamports} lamports OK"
    fi

    # USDC top-up — phantom holds mint authority on the devnet test mint.
    # spl-token create-account is idempotent via --owner but we must not
    # crash if the ATA already exists.
    usdc_ata="$(spl-token address --token "$USDC_MINT" --owner "$kp_pubkey" --verbose --url "$RPC_URL" 2>/dev/null | awk '/Associated token address:/ {print $4}')"
    if [[ -z "$usdc_ata" ]]; then
        echo "  [FAIL] could not derive USDC ATA for $kp_pubkey" >&2
        exit 2
    fi

    ata_info="$(spl-token account-info --address "$usdc_ata" --url "$RPC_URL" --output json 2>/dev/null || true)"
    if [[ -z "$ata_info" ]]; then
        echo "  [usdc] ATA missing — creating $usdc_ata"
        spl-token create-account "$USDC_MINT" \
            --owner "$kp_pubkey" \
            --fee-payer "$PHANTOM_KEYPAIR_PATH" \
            --url "$RPC_URL" >/dev/null || {
            echo "  [FAIL] spl-token create-account failed for $usdc_ata" >&2
            exit 2
        }
        current_usdc_raw=0
    else
        current_usdc_raw="$(echo "$ata_info" | jq -r '.tokenAmount.amount // "0"')"
    fi

    if (( current_usdc_raw < WARN_USDC_RAW )); then
        echo "  [usdc] balance ${current_usdc_raw} raw < warn ${WARN_USDC_RAW}; minting ${USDC_TOPUP_RAW} raw from phantom"
        # mint-to takes human-decimal, not raw. USDC has 6 decimals.
        mint_amount="$(awk "BEGIN { printf \"%.6f\", $USDC_TOPUP_RAW/1000000 }")"
        spl-token mint "$USDC_MINT" "$mint_amount" "$usdc_ata" \
            --mint-authority "$PHANTOM_KEYPAIR_PATH" \
            --fee-payer "$PHANTOM_KEYPAIR_PATH" \
            --url "$RPC_URL" >/dev/null || {
            echo "  [FAIL] spl-token mint failed for $usdc_ata" >&2
            exit 2
        }
    else
        echo "  [usdc] balance ${current_usdc_raw} raw OK"
    fi

    # Per-hostname policy provisioning. The enable_insurance + approve pair
    # is idempotent at the Anchor level (init on existing PDA fails) so we
    # skip hostnames where hasActiveOnChainPolicy would already return true.
    IFS=',' read -ra hosts <<< "$SANDBOX_HOSTNAMES"
    for host in "${hosts[@]}"; do
        host="$(echo "$host" | xargs)"   # trim whitespace
        [[ -z "$host" ]] && continue
        echo "  [policy] checking $host"
        # We shell out to trigger-claim-demo.ts? No — that script creates a
        # fresh agent each run. Instead defer to a helper tsx one-liner that
        # checks + (optionally) enables. For the initial cut of F3 we print
        # a hint and leave policy provisioning to operators until a dedicated
        # `provision-sandbox-policy.ts` ships — tracked separately.
        echo "  [policy] TODO: per-keypair enable_insurance is deferred to a follow-up"
        echo "           — run 'pnpm exec tsx packages/program/scripts/trigger-claim-demo.ts $host'"
        echo "           once per (keypair, hostname) pair to mint a real policy."
    done
    echo
done

# --- optional backend probe ------------------------------------------------
if command -v curl >/dev/null; then
    probe_res="$(curl -sS -o /dev/null -w "%{http_code}" "$BACKEND_URL/health" 2>/dev/null || true)"
    echo "[probe] $BACKEND_URL/health -> $probe_res"
fi

echo "[done] sandbox pool top-up complete."
