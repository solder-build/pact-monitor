# Pact Network — Samples

## demo/
Runnable demos that call real Solana APIs through both SDKs and sync to a
local backend. Point the scorecard at the same backend to see things
update in real time.

### Monitor
- **`monitor.ts`** — 5-provider reliability loop. Prints a latency/failure
  summary; scorecard updates live.

### Insurance
- **`insurance-basic.ts`** — standalone `PactInsurance`: enable policy,
  estimate premium, read policy state.
- **`monitor-plus-insurance.ts`** — both SDKs composed: signed monitor
  batches, on-chain policy, `monitor.on("failure")` for local alerting.
- **`insured-agent.ts`** — flagship Phase 3 flow. Creates a fresh agent,
  funds it with test USDC, enables insurance via the SDK, runs N success
  + 1 forced-failure calls, prints on-chain pool deltas + explorer links.

See `samples/demo/README.md` for exact commands and per-demo pre-reqs.

## playground/
Browser-based monitor playground. Paste any URL, click Monitor, see the result. Open `samples/playground/index.html` in your browser.

## agent-integration/
Copy-paste examples for integrating the **monitor** SDK into your agent
(no Solana deps):
- `basic.ts` — Minimal 10-line integration
- `with-schema-validation.ts` — Detect broken API responses
- `with-x402.ts` — Track USDC payment amounts

For insurance-SDK examples (on-chain policy + claims), see `samples/demo/`.
