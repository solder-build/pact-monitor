# @pact-network/wrap-v2

V2 fetch-call wrap library — V2 sibling of `@pact-network/wrap`. Same
contract (`wrapFetch` + four `EventSink` implementations + `X-Pact-*`
response headers + fire-and-forget settlement publish) but typed against
V2's per-call settle/claim split.

## Key V2 differences vs `@pact-network/wrap`

- **`PolicyConfig` (not `EndpointConfig`)**: hostname-keyed, carries the
  on-chain `insurance_rate_bps` / `min_premium_bps` / `max_coverage_per_call`
  snapshot the consumer reads from `CoveragePool`.
- **Premium math**:
  `premium = max(callValue × insuranceRateBps/10_000, callValue × minPremiumBps/10_000)`
- **Refund target on breach** (cranker re-clamps on-chain):
  `paymentAmount = min(callValue, maxCoveragePerCall)`
- **`V2SettlementEvent` carries a breach tail** (`paymentAmount`,
  `evidenceHash`, `statusCode`, `triggerType`, `callTimestamp`) only when
  `paymentAmount > 0` — settler-v2's claim pipeline can filter cheaply.
- **`H-05` baked in**: premium IS charged on `server_error` /
  `network_error` / `latency_breach`. `4xx` is the only outcome with
  premium=0.

## Build + test

```bash
pnpm --filter @pact-network/wrap-v2 build
pnpm --filter @pact-network/wrap-v2 test    # 43/43
```

## Usage

```typescript
import { wrapFetch, defaultClassifier, PubSubEventSink } from "@pact-network/wrap-v2";

const sink = new PubSubEventSink({ topic: pubsub.topic("pact-v2-premium") });

const result = await wrapFetch({
  hostname: "api.openai.com",
  walletPubkey: agentPubkey.toBase58(),
  upstreamUrl: "https://api.openai.com/v1/chat/completions",
  callValue: 1_000_000n,                    // 1 USDC of API value
  policyConfig: {
    hostname: "api.openai.com",
    policyPda: agentPolicyPda.toBase58(),
    sla_latency_ms: 1500,
    insurance_rate_bps: 200,
    min_premium_bps: 50,
    max_coverage_per_call: 10_000_000n,
  },
  classifier: defaultClassifier,
  sink,
});
```

`X-Pact-Hostname`, `X-Pact-Policy`, and `X-Pact-Evidence` (on breach)
are added to the response on top of V1's `X-Pact-*` set.
