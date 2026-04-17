import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { CallRecord } from "./types.js";

export class PactStorage {
  private filePath: string;

  constructor(storagePath?: string) {
    this.filePath = storagePath || join(homedir(), ".pact-monitor", "records.jsonl");
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  append(record: CallRecord): void {
    appendFileSync(this.filePath, JSON.stringify(record) + "\n");
  }

  getUnsynced(): CallRecord[] {
    return this.readAll().filter((r) => !r.synced);
  }

  markSynced(count: number): void {
    const records = this.readAll();
    let marked = 0;
    for (const record of records) {
      if (!record.synced && marked < count) {
        record.synced = true;
        marked++;
      }
    }
    writeFileSync(this.filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  getStats(): {
    totalCalls: number;
    failureRate: number;
    avgLatencyMs: number;
    byProvider: Record<string, { calls: number; failureRate: number }>;
  } {
    const records = this.readAll();
    const total = records.length;
    const failures = records.filter((r) => r.classification !== "success").length;
    const avgLatency = total > 0
      ? records.reduce((sum, r) => sum + r.latencyMs, 0) / total
      : 0;

    const byProvider: Record<string, { calls: number; failures: number }> = {};
    for (const r of records) {
      if (!byProvider[r.hostname]) byProvider[r.hostname] = { calls: 0, failures: 0 };
      byProvider[r.hostname].calls++;
      if (r.classification !== "success") byProvider[r.hostname].failures++;
    }

    return {
      totalCalls: total,
      failureRate: total > 0 ? failures / total : 0,
      avgLatencyMs: Math.round(avgLatency),
      byProvider: Object.fromEntries(
        Object.entries(byProvider).map(([k, v]) => [
          k,
          { calls: v.calls, failureRate: v.calls > 0 ? v.failures / v.calls : 0 },
        ]),
      ),
    };
  }

  getRecords(options?: { limit?: number; provider?: string }): CallRecord[] {
    let records = this.readAll();
    if (options?.provider) {
      records = records.filter((r) => r.hostname === options.provider);
    }
    if (options?.limit) {
      records = records.slice(-options.limit);
    }
    return records;
  }

  private readAll(): CallRecord[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as CallRecord);
  }
}
