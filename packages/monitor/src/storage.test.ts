import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PactStorage } from "./storage.js";
import type { CallRecord } from "./types.js";

function makeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    hostname: "api.example.com",
    endpoint: "/v1/test",
    timestamp: new Date().toISOString(),
    statusCode: 200,
    latencyMs: 100,
    classification: "success",
    payment: null,
    synced: false,
    ...overrides,
  };
}

describe("PactStorage", () => {
  let tmpDir: string;
  let storagePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pact-test-"));
    storagePath = join(tmpDir, "records.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends records and reads them back", () => {
    const storage = new PactStorage(storagePath);
    const r1 = makeRecord({ endpoint: "/a" });
    const r2 = makeRecord({ endpoint: "/b" });
    storage.append(r1);
    storage.append(r2);

    const records = storage.getRecords();
    assert.equal(records.length, 2);
    assert.equal(records[0].endpoint, "/a");
    assert.equal(records[1].endpoint, "/b");
  });

  it("getUnsynced returns only unsynced records", () => {
    const storage = new PactStorage(storagePath);
    storage.append(makeRecord({ synced: false }));
    storage.append(makeRecord({ synced: true }));
    storage.append(makeRecord({ synced: false }));

    const unsynced = storage.getUnsynced();
    assert.equal(unsynced.length, 2);
    for (const r of unsynced) {
      assert.equal(r.synced, false);
    }
  });

  it("markSynced marks the correct number of records", () => {
    const storage = new PactStorage(storagePath);
    storage.append(makeRecord({ synced: false }));
    storage.append(makeRecord({ synced: false }));
    storage.append(makeRecord({ synced: false }));

    storage.markSynced(2);

    const unsynced = storage.getUnsynced();
    assert.equal(unsynced.length, 1);

    const all = storage.getRecords();
    assert.equal(all.filter((r) => r.synced).length, 2);
  });

  it("getStats computes correct totalCalls, failureRate, avgLatencyMs", () => {
    const storage = new PactStorage(storagePath);
    storage.append(makeRecord({ latencyMs: 100, classification: "success" }));
    storage.append(makeRecord({ latencyMs: 200, classification: "success" }));
    storage.append(makeRecord({ latencyMs: 300, classification: "error" }));

    const stats = storage.getStats();
    assert.equal(stats.totalCalls, 3);
    assert.equal(stats.avgLatencyMs, 200);
    assert.ok(Math.abs(stats.failureRate - 1 / 3) < 0.001);
  });

  it("getStats byProvider groups correctly", () => {
    const storage = new PactStorage(storagePath);
    storage.append(makeRecord({ hostname: "api.a.com", classification: "success" }));
    storage.append(makeRecord({ hostname: "api.a.com", classification: "error" }));
    storage.append(makeRecord({ hostname: "api.b.com", classification: "success" }));

    const stats = storage.getStats();
    assert.equal(stats.byProvider["api.a.com"].calls, 2);
    assert.equal(stats.byProvider["api.a.com"].failureRate, 0.5);
    assert.equal(stats.byProvider["api.b.com"].calls, 1);
    assert.equal(stats.byProvider["api.b.com"].failureRate, 0);
  });

  it("getRecords with limit returns correct count", () => {
    const storage = new PactStorage(storagePath);
    for (let i = 0; i < 5; i++) {
      storage.append(makeRecord({ endpoint: `/ep${i}` }));
    }

    const records = storage.getRecords({ limit: 3 });
    assert.equal(records.length, 3);
    // slice(-limit) returns the last N records
    assert.equal(records[0].endpoint, "/ep2");
    assert.equal(records[2].endpoint, "/ep4");
  });

  it("getRecords with provider filter works", () => {
    const storage = new PactStorage(storagePath);
    storage.append(makeRecord({ hostname: "api.a.com" }));
    storage.append(makeRecord({ hostname: "api.b.com" }));
    storage.append(makeRecord({ hostname: "api.a.com" }));

    const records = storage.getRecords({ provider: "api.a.com" });
    assert.equal(records.length, 2);
    for (const r of records) {
      assert.equal(r.hostname, "api.a.com");
    }
  });

  it("works when file does not exist yet (empty state)", () => {
    const storage = new PactStorage(join(tmpDir, "nonexistent", "records.jsonl"));

    const records = storage.getRecords();
    assert.equal(records.length, 0);

    const unsynced = storage.getUnsynced();
    assert.equal(unsynced.length, 0);

    const stats = storage.getStats();
    assert.equal(stats.totalCalls, 0);
    assert.equal(stats.failureRate, 0);
    assert.equal(stats.avgLatencyMs, 0);
  });
});
