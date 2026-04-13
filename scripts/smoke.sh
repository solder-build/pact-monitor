#!/usr/bin/env bash
# Tier 1 smoke test — backend integration against real Postgres.
# Prereqs: `pnpm db:up` and `pnpm --filter backend dev` running.
# Usage:   BASE=http://localhost:3001 scripts/smoke.sh

set -euo pipefail

BASE="${BASE:-http://localhost:3001}"
# Unique hostname per run so the smoke test is idempotent across re-runs
# without needing a DB reset.
HOSTNAME_UNDER_TEST="smoke-$(date +%s)-$$.pact.test"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
step()  { printf "\n\033[1m=> %s\033[0m\n" "$*"; }

fail() { red "FAIL: $*"; exit 1; }
pass() { green "PASS: $*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing dependency: $1"
}
require curl
require jq

step "health check"
curl -sf "$BASE/health" >/dev/null || fail "/health not reachable at $BASE"
pass "/health 200"

step "generate API key"
KEY_OUTPUT=$(cd "$(dirname "$0")/.." && pnpm --silent generate-key "smoke-$(date +%s)")
API_KEY=$(printf "%s\n" "$KEY_OUTPUT" | grep -oE 'pact_[a-f0-9]+' | head -1)
[ -n "$API_KEY" ] || fail "could not extract API key from generate-key output"
pass "key: ${API_KEY:0:12}..."

step "baseline provider count"
BEFORE=$(curl -sf "$BASE/api/v1/providers" | jq 'length')
pass "providers before: $BEFORE"

step "POST /records — ingest 10 records (7 success, 3 failures) for $HOSTNAME_UNDER_TEST"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
BODY=$(jq -n --arg host "$HOSTNAME_UNDER_TEST" --arg ts "$NOW" '
  {
    records: [
      { hostname: $host, endpoint: "/rpc",   timestamp: $ts, status_code: 200, latency_ms:  120, classification: "success" },
      { hostname: $host, endpoint: "/rpc",   timestamp: $ts, status_code: 200, latency_ms:  150, classification: "success" },
      { hostname: $host, endpoint: "/rpc",   timestamp: $ts, status_code: 200, latency_ms:  180, classification: "success" },
      { hostname: $host, endpoint: "/rpc",   timestamp: $ts, status_code: 200, latency_ms:  200, classification: "success" },
      { hostname: $host, endpoint: "/rpc",   timestamp: $ts, status_code: 200, latency_ms:  250, classification: "success" },
      { hostname: $host, endpoint: "/rpc",   timestamp: $ts, status_code: 200, latency_ms:  300, classification: "success" },
      { hostname: $host, endpoint: "/meta",  timestamp: $ts, status_code: 200, latency_ms:  400, classification: "success" },
      { hostname: $host, endpoint: "/rpc",   timestamp: $ts, status_code: 500, latency_ms:  180, classification: "error" },
      { hostname: $host, endpoint: "/rpc",   timestamp: $ts, status_code:   0, latency_ms: 6000, classification: "timeout" },
      { hostname: $host, endpoint: "/meta",  timestamp: $ts, status_code: 200, latency_ms:  200, classification: "schema_mismatch" }
    ]
  }')

ACCEPTED=$(curl -sf -X POST "$BASE/api/v1/records" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" | jq '.accepted')
[ "$ACCEPTED" = "10" ] || fail "expected accepted=10, got $ACCEPTED"
pass "accepted 10 records"

step "provider list grew"
AFTER=$(curl -sf "$BASE/api/v1/providers" | jq 'length')
[ "$AFTER" -ge "$((BEFORE + 1))" ] || fail "expected provider count to grow, $BEFORE -> $AFTER"
pass "providers after: $AFTER"

step "locate smoke provider"
PROVIDER_JSON=$(curl -sf "$BASE/api/v1/providers" | jq --arg name "$HOSTNAME_UNDER_TEST" '.[] | select(.name == $name)')
PID=$(echo "$PROVIDER_JSON" | jq -r '.id')
[ -n "$PID" ] && [ "$PID" != "null" ] || fail "smoke provider not in list"
pass "provider id: $PID"

step "assert failure_rate on /providers list"
LIST_FR=$(echo "$PROVIDER_JSON" | jq '.failure_rate')
# 3 of 10 = 0.3; allow tolerance for floating-point rounding
awk -v fr="$LIST_FR" 'BEGIN { if (fr < 0.29 || fr > 0.31) exit 1 }' \
  || fail "expected failure_rate ≈ 0.30, got $LIST_FR"
pass "failure_rate: $LIST_FR"

step "assert insurance_rate > 0 and tier present"
IR=$(echo "$PROVIDER_JSON" | jq '.insurance_rate')
TIER=$(echo "$PROVIDER_JSON" | jq -r '.tier')
awk -v ir="$IR" 'BEGIN { if (ir <= 0) exit 1 }' || fail "insurance_rate not positive: $IR"
[ -n "$TIER" ] && [ "$TIER" != "null" ] || fail "missing tier"
pass "insurance_rate: $IR, tier: $TIER"

step "GET /providers/:id detail"
DETAIL=$(curl -sf "$BASE/api/v1/providers/$PID")
TOTAL=$(echo "$DETAIL" | jq '.total_calls')
FB_TIMEOUT=$(echo "$DETAIL" | jq '.failure_breakdown.timeout')
FB_ERROR=$(echo "$DETAIL" | jq '.failure_breakdown.error')
FB_SCHEMA=$(echo "$DETAIL" | jq '.failure_breakdown.schema_mismatch')
[ "$TOTAL" = "10" ]       || fail "total_calls != 10 (got $TOTAL)"
[ "$FB_TIMEOUT" = "1" ]   || fail "failure_breakdown.timeout != 1 (got $FB_TIMEOUT)"
[ "$FB_ERROR" = "1" ]     || fail "failure_breakdown.error != 1 (got $FB_ERROR)"
[ "$FB_SCHEMA" = "1" ]    || fail "failure_breakdown.schema_mismatch != 1 (got $FB_SCHEMA)"
pass "detail shape correct"

step "assert percentile math produces non-zero p95"
P95=$(echo "$DETAIL" | jq '.p95_latency_ms')
awk -v p="$P95" 'BEGIN { if (p <= 0) exit 1 }' || fail "p95 not positive: $P95"
pass "p95_latency_ms: $P95"

step "GET /providers/:id/timeseries"
TS=$(curl -sf "$BASE/api/v1/providers/$PID/timeseries?granularity=hourly&days=1")
BUCKETS=$(echo "$TS" | jq '.data | length')
[ "$BUCKETS" -ge 1 ] || fail "expected at least 1 timeseries bucket, got $BUCKETS"
pass "timeseries buckets: $BUCKETS"

step "auth gate — POST without bearer → 401"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/records" \
  -H "Content-Type: application/json" -d '{"records":[]}')
[ "$CODE" = "401" ] || fail "expected 401 unauthenticated, got $CODE"
pass "unauthenticated → 401"

step "validation — empty records array → 400"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/records" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" -d '{"records":[]}')
[ "$CODE" = "400" ] || fail "expected 400 empty batch, got $CODE"
pass "empty batch → 400"

step "404 on unknown provider"
CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "$BASE/api/v1/providers/00000000-0000-0000-0000-000000000000")
[ "$CODE" = "404" ] || fail "expected 404 for unknown provider, got $CODE"
pass "unknown provider → 404"

echo
green "ALL SMOKE CHECKS PASSED"
