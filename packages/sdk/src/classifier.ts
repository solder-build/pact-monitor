import type { Classification, ExpectedSchema } from "./types.js";

export function classify(
  statusCode: number,
  latencyMs: number,
  latencyThresholdMs: number,
  responseBody: unknown,
  expectedSchema?: ExpectedSchema,
  networkError?: boolean,
): Classification {
  if (networkError || statusCode === 0) {
    return "error";
  }

  if (statusCode < 200 || statusCode >= 300) {
    return "error";
  }

  if (latencyMs > latencyThresholdMs) {
    return "timeout";
  }

  if (expectedSchema && responseBody !== undefined) {
    if (!matchesSchema(responseBody, expectedSchema)) {
      return "schema_mismatch";
    }
  }

  return "success";
}

function matchesSchema(body: unknown, schema: ExpectedSchema): boolean {
  if (schema.type === "object" && (typeof body !== "object" || body === null)) {
    return false;
  }
  if (schema.type === "array" && !Array.isArray(body)) {
    return false;
  }
  if (schema.required && typeof body === "object" && body !== null) {
    for (const key of schema.required) {
      if (!(key in body)) {
        return false;
      }
    }
  }
  return true;
}
