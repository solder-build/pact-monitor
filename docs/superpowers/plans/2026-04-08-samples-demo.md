# Samples & Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build demo scripts, a browser playground, and integration examples that showcase Pact Monitor's full pipeline — from API call to scorecard display.

**Architecture:** Three independent sample folders plus one new backend endpoint. The demo script uses the SDK directly. The playground calls a new `POST /api/v1/monitor` backend endpoint that wraps the SDK server-side. Integration examples are standalone runnable files.

**Tech Stack:** TypeScript, @pact-network/monitor SDK, Fastify (backend endpoint), vanilla HTML/CSS/JS (playground)

**Spec:** `docs/superpowers/specs/2026-04-08-samples-demo-design.md`

**Branch:** `feature/samples` from `develop`

---

## File Map

### Backend (modified)
| File | Action | Responsibility |
|------|--------|---------------|
| `packages/backend/src/routes/monitor.ts` | Create | POST /api/v1/monitor — proxy endpoint for playground |
| `packages/backend/src/index.ts` | Modify | Register monitorRoutes |

### Samples
| File | Action | Responsibility |
|------|--------|---------------|
| `samples/README.md` | Create | Overview of all samples |
| `samples/demo/monitor.ts` | Create | Hackathon demo script |
| `samples/demo/.env.example` | Create | API key config |
| `samples/demo/README.md` | Create | How to run the demo |
| `samples/playground/index.html` | Create | Standalone monitor playground |
| `samples/playground/style.css` | Create | Pact design system theme |
| `samples/playground/README.md` | Create | How to use playground |
| `samples/agent-integration/basic.ts` | Create | Minimal SDK usage |
| `samples/agent-integration/with-schema-validation.ts` | Create | Schema checking example |
| `samples/agent-integration/with-x402.ts` | Create | x402 payment monitoring |
| `samples/agent-integration/README.md` | Create | Integration examples overview |

---

## Task 1: Create Feature Branch

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout develop
git checkout -b feature/samples
```

- [ ] **Step 2: Verify**

```bash
git branch --show-current
```

Expected: `feature/samples`

---

## Task 2: Backend Monitor Endpoint

**Files:**
- Create: `packages/backend/src/routes/monitor.ts`
- Modify: `packages/backend/src/index.ts`

- [ ] **Step 1: Create monitor.ts**

```typescript
import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../middleware/auth.js";
import { query, getOne } from "../db.js";

interface MonitorBody {
  url: string;
  method?: string;
}

async function findOrCreateProvider(hostname: string): Promise<string> {
  const existing = await getOne<{ id: string }>(
    "SELECT id FROM providers WHERE base_url = $1",
    [hostname],
  );
  if (existing) return existing.id;

  const created = await getOne<{ id: string }>(
    "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
    [hostname, hostname],
  );
  return created!.id;
}

function classify(statusCode: number, latencyMs: number, networkError: boolean): string {
  if (networkError || statusCode === 0) return "error";
  if (statusCode < 200 || statusCode >= 300) return "error";
  if (latencyMs > 5000) return "timeout";
  return "success";
}

export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: MonitorBody }>(
    "/api/v1/monitor",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { url, method = "GET" } = request.body;

      if (!url) {
        return reply.code(400).send({ error: "url is required" });
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return reply.code(400).send({ error: "Invalid URL" });
      }

      const hostname = parsed.hostname;
      const endpoint = parsed.pathname;
      const start = Date.now();
      let statusCode = 0;
      let networkError = false;

      try {
        const res = await fetch(url, { method });
        statusCode = res.status;
      } catch {
        networkError = true;
      }

      const latencyMs = Date.now() - start;
      const classification = classify(statusCode, latencyMs, networkError);

      const agentId = (request as import("fastify").FastifyRequest & { agentId: string }).agentId;
      const providerId = await findOrCreateProvider(hostname);

      await query(
        `INSERT INTO call_records (
          provider_id, endpoint, timestamp, status_code, latency_ms,
          classification, agent_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [providerId, endpoint, new Date().toISOString(), statusCode, latencyMs, classification, agentId],
      );

      return {
        status_code: statusCode,
        latency_ms: latencyMs,
        classification,
        provider: hostname,
        payment: null,
      };
    },
  );
}
```

- [ ] **Step 2: Register in index.ts**

Add to `packages/backend/src/index.ts` after the existing imports:

```typescript
import { monitorRoutes } from "./routes/monitor.js";
```

Add after the existing `app.register` calls:

```typescript
await app.register(monitorRoutes);
```

- [ ] **Step 3: Test the endpoint**

Start the backend and test:
```bash
cd packages/backend && pnpm tsx src/index.ts &
sleep 2

# Generate a key if needed
pnpm tsx src/scripts/generate-key.ts playground-test

# Test the endpoint (replace YOUR_KEY)
curl -X POST http://localhost:3001/api/v1/monitor \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"url": "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"}'
```

Expected: `{"status_code":200,"latency_ms":...,"classification":"success","provider":"api.coingecko.com","payment":null}`

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/routes/monitor.ts packages/backend/src/index.ts
git commit -m "feat(backend): add POST /api/v1/monitor endpoint for playground"
```

---

## Task 3: Demo Script

**Files:**
- Create: `samples/demo/monitor.ts`
- Create: `samples/demo/.env.example`
- Create: `samples/demo/README.md`

- [ ] **Step 1: Create .env.example**

```env
# Required — get from: pnpm run generate-key demo
PACT_API_KEY=pact_your_key_here
PACT_BACKEND_URL=http://localhost:3001

# Optional — skip if not available
HELIUS_API_KEY=
QUICKNODE_RPC_URL=
```

- [ ] **Step 2: Create monitor.ts**

```typescript
import "dotenv/config";
import { pactMonitor } from "../../packages/sdk/src/index.js";

const PACT_API_KEY = process.env.PACT_API_KEY;
const PACT_BACKEND_URL = process.env.PACT_BACKEND_URL || "http://localhost:3001";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const QUICKNODE_RPC_URL = process.env.QUICKNODE_RPC_URL;

if (!PACT_API_KEY) {
  console.error("PACT_API_KEY is required. Run: pnpm run generate-key demo");
  process.exit(1);
}

const monitor = pactMonitor({
  apiKey: PACT_API_KEY,
  backendUrl: PACT_BACKEND_URL,
  syncEnabled: true,
  syncIntervalMs: 5_000,
  latencyThresholdMs: 5_000,
});

interface Provider {
  name: string;
  url: string;
  skip?: boolean;
  reason?: string;
}

const providers: Provider[] = [
  {
    name: "CoinGecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  },
  {
    name: "DexScreener",
    url: "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
  },
  {
    name: "Jupiter",
    url: "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000",
  },
  {
    name: "Helius",
    url: HELIUS_API_KEY
      ? `https://api.helius.xyz/v0/addresses/vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg/transactions?api-key=${HELIUS_API_KEY}`
      : "",
    skip: !HELIUS_API_KEY,
    reason: "No HELIUS_API_KEY configured",
  },
  {
    name: "QuickNode",
    url: QUICKNODE_RPC_URL || "",
    skip: !QUICKNODE_RPC_URL,
    reason: "No QUICKNODE_RPC_URL configured",
  },
];

const ROUNDS = parseInt(process.argv[2] || "5", 10);

function pad(str: string, len: number): string {
  return str.padEnd(len);
}

function colorClass(cls: string): string {
  if (cls === "success") return "\x1b[32m" + cls + "\x1b[0m";
  if (cls === "timeout") return "\x1b[33m" + cls + "\x1b[0m";
  return "\x1b[31m" + cls + "\x1b[0m";
}

console.log("=== Pact Network — Live Monitor Demo ===");
console.log(`Backend: ${PACT_BACKEND_URL}`);
console.log(`Rounds: ${ROUNDS}`);
console.log("");

for (const p of providers) {
  if (p.skip) {
    console.log(`  Skipping ${p.name} — ${p.reason}`);
  }
}
console.log("");

const results: Array<{ provider: string; status: number; latency: number; classification: string }> = [];

for (let round = 1; round <= ROUNDS; round++) {
  console.log(`--- Round ${round}/${ROUNDS} ---`);

  for (const p of providers) {
    if (p.skip) continue;

    try {
      const start = Date.now();
      const res = await monitor.fetch(p.url);
      const latency = Date.now() - start;
      const status = res.status;
      const classification = status >= 200 && status < 300 ? "success" : "error";

      results.push({ provider: p.name, status, latency, classification });
      console.log(
        `  ${pad(p.name, 14)} ${pad(String(status), 5)} ${pad(latency + "ms", 8)} ${colorClass(classification)}`,
      );
    } catch (err) {
      results.push({ provider: p.name, status: 0, latency: 0, classification: "error" });
      console.log(
        `  ${pad(p.name, 14)} ${pad("ERR", 5)} ${pad("-", 8)} ${colorClass("error")}`,
      );
    }
  }

  if (round < ROUNDS) {
    console.log("  Waiting 2s before next round...");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Print summary
console.log("");
console.log("=== Summary ===");
const byProvider = new Map<string, { calls: number; failures: number; totalLatency: number }>();
for (const r of results) {
  const existing = byProvider.get(r.provider) || { calls: 0, failures: 0, totalLatency: 0 };
  existing.calls++;
  if (r.classification !== "success") existing.failures++;
  existing.totalLatency += r.latency;
  byProvider.set(r.provider, existing);
}

for (const [name, stats] of byProvider) {
  const failRate = ((stats.failures / stats.calls) * 100).toFixed(1);
  const avgLatency = Math.round(stats.totalLatency / stats.calls);
  console.log(
    `  ${pad(name, 14)} ${stats.calls} calls, ${failRate}% fail, avg ${avgLatency}ms`,
  );
}

console.log("");
console.log("Flushing to backend...");
monitor.shutdown();
console.log("Done. Check the scorecard at http://localhost:5173");
```

- [ ] **Step 3: Create README.md**

```markdown
# Pact Monitor — Demo Script

Live monitoring demo for hackathon presentations. Calls real Solana APIs through the Pact Monitor SDK and syncs results to the backend in real-time.

## Setup

```bash
cd samples/demo
cp .env.example .env
```

Edit `.env` with your Pact API key (generate with `pnpm run generate-key demo` from project root).

Optionally add Helius/QuickNode keys for more providers.

## Run

```bash
# Default: 5 rounds
pnpm tsx monitor.ts

# Custom rounds
pnpm tsx monitor.ts 10
```

Open the scorecard at http://localhost:5173 to see results appear live.
```

- [ ] **Step 4: Commit**

```bash
git add samples/demo/
git commit -m "feat(samples): add hackathon demo script with live API monitoring"
```

---

## Task 4: Browser Playground

**Files:**
- Create: `samples/playground/index.html`
- Create: `samples/playground/style.css`
- Create: `samples/playground/README.md`

- [ ] **Step 1: Create style.css**

```css
@import url('https://fonts.googleapis.com/css2?family=Inria+Sans:wght@400;700&family=Inria+Serif:wght@400;700&family=JetBrains+Mono:wght@400;500&display=swap');

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: #151311;
  color: #ccc;
  font-family: 'Inria Sans', sans-serif;
  padding: 40px;
  max-width: 800px;
  margin: 0 auto;
}

h1 {
  font-family: 'Inria Serif', serif;
  font-size: 24px;
  color: #e0ddd8;
  margin-bottom: 4px;
}

.subtitle {
  font-size: 14px;
  color: #666;
  margin-bottom: 32px;
}

label {
  display: block;
  font-size: 12px;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 2px;
  margin-bottom: 6px;
}

input, select, button {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  background: #1a1917;
  color: #ccc;
  border: 1px solid #333330;
  padding: 10px 14px;
  border-radius: 0;
  outline: none;
}

input:focus, select:focus {
  border-color: #B87333;
}

.input-row {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}

.input-row input {
  flex: 1;
}

.input-row select {
  width: 100px;
}

button {
  background: transparent;
  border: 1px solid #B87333;
  color: #B87333;
  cursor: pointer;
  padding: 10px 24px;
  text-transform: uppercase;
  letter-spacing: 2px;
  font-size: 12px;
}

button:hover {
  background: #B87333;
  color: #151311;
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.result-card {
  background: #1a1917;
  border: 1px solid #333330;
  padding: 20px;
  margin-bottom: 32px;
  display: none;
}

.result-card.visible {
  display: block;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.result-item label {
  margin-bottom: 4px;
}

.result-item .value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px;
}

.success { color: #5A6B7A; }
.timeout { color: #B87333; }
.error { color: #C9553D; }
.schema_mismatch { color: #C9553D; }

.history {
  margin-top: 32px;
}

.history h2 {
  font-family: 'Inria Serif', serif;
  font-size: 16px;
  color: #e0ddd8;
  margin-bottom: 12px;
}

.history-table {
  width: 100%;
  border-collapse: collapse;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}

.history-table th {
  text-align: left;
  padding: 8px 6px;
  color: #888;
  border-bottom: 1px solid #333330;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 2px;
  font-weight: normal;
}

.history-table td {
  padding: 8px 6px;
  border-bottom: 1px solid #222;
}

.config-row {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
  align-items: flex-end;
}

.config-row .field {
  flex: 1;
}

.config-row input {
  width: 100%;
}

.scorecard-link {
  display: inline-block;
  margin-top: 16px;
  color: #B87333;
  font-size: 13px;
  text-decoration: none;
  border-bottom: 1px solid #B87333;
}

.scorecard-link:hover {
  color: #e0ddd8;
  border-color: #e0ddd8;
}
```

- [ ] **Step 2: Create index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pact Monitor — Playground</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Pact Monitor Playground</h1>
  <p class="subtitle">Call any API and see how Pact classifies it</p>

  <div class="config-row">
    <div class="field">
      <label>Backend URL</label>
      <input type="text" id="backendUrl" value="http://localhost:3001">
    </div>
    <div class="field">
      <label>API Key</label>
      <input type="text" id="apiKey" placeholder="pact_...">
    </div>
  </div>

  <label>Target URL</label>
  <div class="input-row">
    <select id="method">
      <option value="GET">GET</option>
      <option value="POST">POST</option>
    </select>
    <input type="text" id="url" placeholder="https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd">
    <button id="monitorBtn" onclick="doMonitor()">Monitor</button>
  </div>

  <div class="result-card" id="resultCard">
    <div class="result-grid">
      <div class="result-item">
        <label>Status</label>
        <div class="value" id="resStatus">—</div>
      </div>
      <div class="result-item">
        <label>Latency</label>
        <div class="value" id="resLatency">—</div>
      </div>
      <div class="result-item">
        <label>Classification</label>
        <div class="value" id="resClass">—</div>
      </div>
      <div class="result-item">
        <label>Provider</label>
        <div class="value" id="resProvider">—</div>
      </div>
    </div>
  </div>

  <div class="history">
    <h2>History</h2>
    <table class="history-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Provider</th>
          <th>Status</th>
          <th>Latency</th>
          <th>Classification</th>
        </tr>
      </thead>
      <tbody id="historyBody"></tbody>
    </table>
    <a class="scorecard-link" href="http://localhost:5173" target="_blank">View on Scorecard</a>
  </div>

  <script>
    const history = [];

    async function doMonitor() {
      const backendUrl = document.getElementById('backendUrl').value.replace(/\/$/, '');
      const apiKey = document.getElementById('apiKey').value;
      const url = document.getElementById('url').value;
      const method = document.getElementById('method').value;
      const btn = document.getElementById('monitorBtn');

      if (!url) return;
      if (!apiKey) { alert('API key is required'); return; }

      btn.disabled = true;
      btn.textContent = '...';

      try {
        const res = await fetch(`${backendUrl}/api/v1/monitor`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ url, method }),
        });

        const data = await res.json();

        document.getElementById('resultCard').classList.add('visible');
        document.getElementById('resStatus').textContent = data.status_code || 'ERR';
        document.getElementById('resLatency').textContent = data.latency_ms + 'ms';
        document.getElementById('resClass').textContent = data.classification;
        document.getElementById('resClass').className = 'value ' + data.classification;
        document.getElementById('resProvider').textContent = data.provider;

        history.unshift({
          time: new Date().toLocaleTimeString(),
          provider: data.provider,
          status: data.status_code,
          latency: data.latency_ms,
          classification: data.classification,
        });

        renderHistory();
      } catch (err) {
        alert('Failed to reach backend: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Monitor';
      }
    }

    function renderHistory() {
      const tbody = document.getElementById('historyBody');
      tbody.innerHTML = history.slice(0, 20).map(h => `
        <tr>
          <td>${h.time}</td>
          <td>${h.provider}</td>
          <td>${h.status}</td>
          <td>${h.latency}ms</td>
          <td class="${h.classification}">${h.classification}</td>
        </tr>
      `).join('');
    }

    document.getElementById('url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doMonitor();
    });
  </script>
</body>
</html>
```

- [ ] **Step 3: Create README.md**

```markdown
# Pact Monitor — Playground

Browser-based tool to monitor any API call through Pact Network.

## Prerequisites

- Backend running (`pnpm dev:backend` from project root)
- An API key (`pnpm run generate-key playground` from project root)

## Usage

Open `index.html` in your browser, enter your backend URL and API key, paste any URL, and click Monitor.

Results are stored in the database and appear on the scorecard.
```

- [ ] **Step 4: Commit**

```bash
git add samples/playground/
git commit -m "feat(samples): add browser-based monitor playground"
```

---

## Task 5: Agent Integration Examples

**Files:**
- Create: `samples/agent-integration/basic.ts`
- Create: `samples/agent-integration/with-schema-validation.ts`
- Create: `samples/agent-integration/with-x402.ts`
- Create: `samples/agent-integration/README.md`

- [ ] **Step 1: Create basic.ts**

```typescript
// Pact Monitor — Basic Integration
// Run: pnpm tsx samples/agent-integration/basic.ts

import { pactMonitor } from "../../packages/sdk/src/index.js";

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  backendUrl: process.env.PACT_BACKEND_URL || "http://localhost:3001",
  syncEnabled: true,
});

// Replace fetch() with monitor.fetch() — same API, now monitored
const res = await monitor.fetch(
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
);
const data = await res.json();
console.log("Solana price:", data.solana.usd, "USD");
console.log("Local stats:", monitor.getStats());

monitor.shutdown();
```

- [ ] **Step 2: Create with-schema-validation.ts**

```typescript
// Pact Monitor — Schema Validation Example
// Detects when an API returns 200 but the body structure is unexpected.
// Run: pnpm tsx samples/agent-integration/with-schema-validation.ts

import { pactMonitor } from "../../packages/sdk/src/index.js";

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  backendUrl: process.env.PACT_BACKEND_URL || "http://localhost:3001",
  syncEnabled: true,
});

// Call with expected schema — should be "success" if body matches
const res1 = await monitor.fetch(
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  {},
  {
    expectedSchema: {
      type: "object",
      required: ["solana"],
    },
  },
);
console.log("With valid schema:", res1.status);

// Call with a wrong schema — should be classified as "schema_mismatch"
// (API returns { solana: {...} } but we expect a "bitcoin" key)
const res2 = await monitor.fetch(
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  {},
  {
    expectedSchema: {
      type: "object",
      required: ["bitcoin"],
    },
  },
);
console.log("With wrong schema:", res2.status);

const stats = monitor.getStats();
console.log("Total calls:", stats.totalCalls);
console.log("Failure rate:", (stats.failureRate * 100).toFixed(1) + "%");

monitor.shutdown();
```

- [ ] **Step 3: Create with-x402.ts**

```typescript
// Pact Monitor — x402 Payment Monitoring Example
// Shows how to track USDC amounts alongside API calls.
// In production, the SDK auto-extracts payment data from x402/MPP headers.
// This example uses manual usdcAmount override for demonstration.
// Run: pnpm tsx samples/agent-integration/with-x402.ts

import { pactMonitor } from "../../packages/sdk/src/index.js";

const monitor = pactMonitor({
  apiKey: process.env.PACT_API_KEY,
  backendUrl: process.env.PACT_BACKEND_URL || "http://localhost:3001",
  syncEnabled: true,
});

// Simulate a paid API call — $0.005 USDC per call
// In production, the SDK reads this from x402 PAYMENT-RESPONSE headers automatically
const res = await monitor.fetch(
  "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000",
  {},
  {
    usdcAmount: 0.005, // Manual override: $0.005 USDC
  },
);

const data = await res.json();
console.log("Jupiter quote received");
console.log("Input amount:", data.inAmount);
console.log("Output amount:", data.outAmount);

// Check local records — payment data should be attached
const records = monitor.getRecords({ limit: 1 });
if (records.length > 0) {
  const last = records[0];
  console.log("\nCall record:");
  console.log("  Provider:", last.hostname);
  console.log("  Classification:", last.classification);
  console.log("  Payment:", last.payment ? `${last.payment.amount / 1_000_000} USDC` : "none");
}

monitor.shutdown();
```

- [ ] **Step 4: Create README.md**

```markdown
# Pact Monitor — Agent Integration Examples

Copy-paste examples showing how to integrate the Pact Monitor SDK into your agent.

## Prerequisites

- Backend running (`pnpm dev:backend` from project root)
- API key set: `export PACT_API_KEY=pact_your_key`

## Examples

### basic.ts — Minimal Integration
```bash
pnpm tsx samples/agent-integration/basic.ts
```
10 lines. Replace `fetch()` with `monitor.fetch()`, see local stats.

### with-schema-validation.ts — Detect Bad Responses
```bash
pnpm tsx samples/agent-integration/with-schema-validation.ts
```
Shows how APIs that return 200 but wrong body get classified as `schema_mismatch`.

### with-x402.ts — Track Payment Amounts
```bash
pnpm tsx samples/agent-integration/with-x402.ts
```
Attach USDC amounts to monitored calls. In production, the SDK auto-extracts from x402/MPP headers.
```

- [ ] **Step 5: Commit**

```bash
git add samples/agent-integration/
git commit -m "feat(samples): add agent integration examples (basic, schema, x402)"
```

---

## Task 6: Root README & Cleanup

**Files:**
- Create: `samples/README.md`

- [ ] **Step 1: Create samples/README.md**

```markdown
# Pact Network — Samples

## demo/
Hackathon demo script. Calls real Solana APIs through the SDK and syncs to backend in real-time. Run during presentations with the scorecard open.

```bash
cd samples/demo && pnpm tsx monitor.ts
```

## playground/
Browser-based monitor playground. Paste any URL, click Monitor, see the result. Open `samples/playground/index.html` in your browser.

## agent-integration/
Copy-paste examples for integrating the SDK into your agent:
- `basic.ts` — Minimal 10-line integration
- `with-schema-validation.ts` — Detect broken API responses
- `with-x402.ts` — Track USDC payment amounts
```

- [ ] **Step 2: Commit**

```bash
git add samples/README.md
git commit -m "docs(samples): add root README listing all samples"
```

---

## Summary

| Task | Component | Description |
|------|-----------|------------|
| 1 | Git | Create feature/samples branch from develop |
| 2 | Backend | POST /api/v1/monitor endpoint for playground |
| 3 | Demo | Hackathon demo script calling real Solana APIs |
| 4 | Playground | Standalone HTML playground with Pact design system |
| 5 | Examples | Three agent integration examples (basic, schema, x402) |
| 6 | Docs | Root samples README |

**Parallelization:** Tasks 3, 4, 5 are independent (demo, playground, examples) and can run in parallel after Task 2 (backend endpoint) is done. Task 2 must be first since the playground depends on the monitor endpoint.
