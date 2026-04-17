import { PactMonitor } from "./wrapper.js";
import type { PactConfig, PactFetchOptions } from "./types.js";

export function pactMonitor(config?: PactConfig): PactMonitor {
  return new PactMonitor(config);
}

export { PactMonitor } from "./wrapper.js";
export type {
  CallRecord,
  Classification,
  PaymentData,
  PactConfig,
  PactFetchOptions,
  ExpectedSchema,
} from "./types.js";
