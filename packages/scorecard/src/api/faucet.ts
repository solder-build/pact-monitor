const BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/v1/faucet`;

export interface FaucetStatus {
  enabled: boolean;
  network: string;
  maxPerDrip: number;
  minPerDrip: number;
  mint: string;
  reason?: string;
}

export interface FaucetDripResponse {
  signature: string;
  amount: number;
  recipient: string;
  ata: string;
  network: string;
  explorer: string;
}

export interface FaucetError {
  error: string;
  message?: string;
  reason?: string;
  retryAfterSec?: number;
}

export async function getFaucetStatus(): Promise<FaucetStatus> {
  const res = await fetch(`${BASE}/status`);
  if (!res.ok) {
    throw new Error(`Faucet status error: ${res.status}`);
  }
  return res.json();
}

export interface DripArgs {
  recipient: string;
  amount: number;
}

// Discriminated return type: caller can narrow on `ok` to pick the right
// branch instead of wrapping every call in try/catch for the expected 429.
export type DripResult =
  | { ok: true; data: FaucetDripResponse }
  | { ok: false; status: number; error: FaucetError; retryAfterSec?: number };

export async function requestDrip(args: DripArgs): Promise<DripResult> {
  const res = await fetch(`${BASE}/drip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });

  if (res.ok) {
    return { ok: true, data: (await res.json()) as FaucetDripResponse };
  }

  // Parse the structured error body if we can; otherwise synthesize one so
  // the UI never hits `undefined.message`.
  let body: FaucetError;
  try {
    body = (await res.json()) as FaucetError;
  } catch {
    body = { error: `HTTP ${res.status}` };
  }

  // Server sets retryAfterSec in the body for both the per-recipient limiter
  // and the per-IP spam-net. Fall back to the Retry-After header if the body
  // is missing it (e.g. the scoped plugin branch).
  const retryHeader = res.headers.get("Retry-After");
  const retryAfterSec =
    body.retryAfterSec ??
    (retryHeader ? parseInt(retryHeader, 10) : undefined);

  return { ok: false, status: res.status, error: body, retryAfterSec };
}
