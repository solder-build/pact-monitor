// Helius account-changes webhook payload. Helius posts an array of changes;
// each entry includes the account public key, the new data (base64), and
// the slot at which the change was observed.
//
// Reference: https://docs.helius.dev/webhooks-and-websockets/account-webhooks
//
// We only consume the subset relevant to our 5 V2 account types.

export interface HeliusAccountChange {
  /** Account public key (base58). */
  account: string;
  /** Base64-encoded new account data. */
  data: string;
  /** Slot at which the change was observed. */
  slot: number;
  /** Whether the account was closed (data length 0). */
  closed?: boolean;
  /** Lamports balance after the change. */
  lamports?: number;
  /** Program owner pubkey. */
  owner?: string;
}

export interface HeliusAccountChangeBatch {
  /** Helius typically sends an array per webhook. */
  changes: HeliusAccountChange[];
}
