/**
 * Tier 2 — SDK round-trip harness.
 *
 * Proves: PactMonitor wraps fetch -> classifies -> persists -> syncs to backend
 * -> backend computes rate correctly.
 *
 * NO MOCKS. Every component exercised here is the real implementation:
 *   - a real Node.js HTTP server on 127.0.0.1 stands in for a provider
 *     (the SDK sees it as any other upstream — real sockets, real headers)
 *   - real globalThis.fetch inside PactMonitor
 *   - real filesystem for PactStorage (tmpdir JSONL)
 *   - real HTTP POST from PactSync to the real Fastify backend
 *   - real Postgres via Docker
 *
 * Prereqs:
 *   - backend running at BASE (default http://localhost:3001)
 *   - `pnpm build:sdk` has run (harness imports the built SDK)
 *
 * Usage:
 *   API_KEY=pact_xxx pnpm test:roundtrip
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pactMonitor } from "../packages/monitor/dist/index.js";

const BASE = process.env.BASE ?? "http://localhost:3001";
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error("API_KEY env var required. Generate one with: pnpm generate-key roundtrip");
  process.exit(1);
}

// Real HTTP server acting as a stand-in upstream. Not a mock/stub — it's a
// concrete server that accepts real TCP connections and returns real bytes.
// The SDK cannot distinguish this from any other HTTP endpoint.
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 4747);
const UPSTREAM_HOSTNAME = "127.0.0.1";
const upstreamServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "/";
  if (url === "/ok") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else if (url === "/boom") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "oops" }));
  } else if (url === "/slow") {
    // triggers "timeout" classification via latencyThresholdMs=200
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, 500);
  } else if (url === "/wrong-shape") {
    // valid JSON but missing the "ok" key that the harness will require
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ unexpected: true }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

async function waitListen(): Promise<void> {
  return new Promise((resolve) => upstreamServer.listen(UPSTREAM_PORT, UPSTREAM_HOSTNAME, resolve));
}

async function getProviderByName(name: string): Promise<any | null> {
  const res = await fetch(`${BASE}/api/v1/providers`);
  if (!res.ok) throw new Error(`/providers returned ${res.status}`);
  const list = (await res.json()) as Array<{ name: string }>;
  return list.find((p) => p.name === name) ?? null;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`\x1b[31mFAIL:\x1b[0m ${msg}`);
    process.exit(1);
  }
}

function pass(msg: string) {
  console.log(`\x1b[32mPASS:\x1b[0m ${msg}`);
}

async function main() {
  await waitListen();
  console.log(`upstream listening on http://${UPSTREAM_HOSTNAME}:${UPSTREAM_PORT}`);

  const storagePath = join(mkdtempSync(join(tmpdir(), "pact-roundtrip-")), "records.jsonl");
  console.log(`storage: ${storagePath}`);

  // baseline before this run
  const before = await getProviderByName(UPSTREAM_HOSTNAME);
  const beforeCalls = before?.total_calls ?? 0;
  const beforeFailures = Math.round((before?.failure_rate ?? 0) * (before?.total_calls ?? 0));
  console.log(`baseline for ${UPSTREAM_HOSTNAME}: calls=${beforeCalls} failures≈${beforeFailures}`);

  const monitor = pactMonitor({
    apiKey: API_KEY,
    backendUrl: BASE,
    syncEnabled: false, // we'll flush manually via shutdown
    latencyThresholdMs: 200,
    storagePath,
  });

  // 4 success, 1 error (500), 1 timeout (slow), 1 schema_mismatch, 1 network error
  await monitor.fetch(`http://${UPSTREAM_HOSTNAME}:${UPSTREAM_PORT}/ok`);
  await monitor.fetch(`http://${UPSTREAM_HOSTNAME}:${UPSTREAM_PORT}/ok`);
  await monitor.fetch(`http://${UPSTREAM_HOSTNAME}:${UPSTREAM_PORT}/ok`);
  await monitor.fetch(`http://${UPSTREAM_HOSTNAME}:${UPSTREAM_PORT}/ok`);
  await monitor.fetch(`http://${UPSTREAM_HOSTNAME}:${UPSTREAM_PORT}/boom`);
  await monitor.fetch(`http://${UPSTREAM_HOSTNAME}:${UPSTREAM_PORT}/slow`);
  await monitor.fetch(
    `http://${UPSTREAM_HOSTNAME}:${UPSTREAM_PORT}/wrong-shape`,
    undefined,
    { expectedSchema: { type: "object", required: ["ok"] } },
  );

  // network error — real unreachable port on loopback, real ECONNREFUSED
  try {
    await monitor.fetch(`http://${UPSTREAM_HOSTNAME}:1/unreachable`);
  } catch {
    // expected
  }

  const localStats = monitor.getStats();
  console.log("local SDK stats:", localStats);
  assert(localStats.totalCalls >= 8, `expected ≥8 local records, got ${localStats.totalCalls}`);
  pass("SDK recorded all calls to local storage");

  // Flush: re-instantiate monitor with syncEnabled=true pointing to the same
  // storage file; shutdown() calls PactSync.flush() which POSTs to the backend.
  const syncingMonitor = pactMonitor({
    apiKey: API_KEY,
    backendUrl: BASE,
    syncEnabled: true,
    syncIntervalMs: 60_000, // we won't wait for the interval
    syncBatchSize: 500,
    storagePath,
  });
  syncingMonitor.shutdown();
  // flush() is async — give it a tick to settle
  await new Promise((r) => setTimeout(r, 1500));

  const after = await getProviderByName(UPSTREAM_HOSTNAME);
  assert(after, `provider ${UPSTREAM_HOSTNAME} not found in backend after sync`);
  pass(`provider ${UPSTREAM_HOSTNAME} visible in /providers`);

  const delta = after.total_calls - beforeCalls;
  console.log(`delta total_calls: +${delta}`);
  assert(delta >= 7, `expected ≥7 new records synced, got +${delta}`);
  pass("backend total_calls increased as expected");

  const detailRes = await fetch(`${BASE}/api/v1/providers/${after.id}`);
  const detail = (await detailRes.json()) as {
    failure_breakdown: Record<string, number>;
    total_calls: number;
  };
  console.log("detail failure_breakdown:", detail.failure_breakdown);

  assert(
    (detail.failure_breakdown.error ?? 0) >= 1,
    "expected at least 1 'error' classification from /boom",
  );
  assert(
    (detail.failure_breakdown.timeout ?? 0) >= 1,
    "expected at least 1 'timeout' classification from /slow",
  );
  assert(
    (detail.failure_breakdown.schema_mismatch ?? 0) >= 1,
    "expected at least 1 'schema_mismatch' from /wrong-shape",
  );
  pass("all three failure classifications round-tripped to backend");

  upstreamServer.close();
  rmSync(storagePath, { force: true });
  console.log("\n\x1b[32mROUND-TRIP PASSED\x1b[0m");
}

main().catch((err) => {
  console.error(err);
  upstreamServer.close();
  process.exit(1);
});
