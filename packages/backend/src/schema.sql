CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Unknown',
  base_url TEXT NOT NULL UNIQUE,
  wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  endpoint TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('success', 'timeout', 'error', 'schema_mismatch')),
  payment_protocol TEXT CHECK (payment_protocol IN ('x402', 'mpp') OR payment_protocol IS NULL),
  payment_amount BIGINT,
  payment_asset TEXT,
  payment_network TEXT,
  payer_address TEXT,
  recipient_address TEXT,
  tx_hash TEXT,
  settlement_success BOOLEAN,
  agent_id TEXT,
  agent_pubkey TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_records_provider_id ON call_records(provider_id);
CREATE INDEX IF NOT EXISTS idx_call_records_timestamp ON call_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_call_records_classification ON call_records(classification);

-- Idempotency guard: an agent's SDK client may re-flush the same record on
-- multiple sync cycles (e.g. during shutdown race). Without this partial
-- unique index, each re-flush would insert a fresh call_records row with a
-- new UUID, each deriving a distinct claim PDA on-chain and landing a fresh
-- refund. Keyed on the tuple that uniquely identifies a single agent call:
-- (agent_pubkey, timestamp, endpoint). Only enforced for rows that carry
-- an agent_pubkey (anonymous traffic can still be duplicated).
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_records_agent_idempotency
  ON call_records(agent_pubkey, timestamp, endpoint)
  WHERE agent_pubkey IS NOT NULL;

CREATE TABLE IF NOT EXISTS backend_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_metrics_created ON backend_metrics(created_at);
CREATE INDEX IF NOT EXISTS idx_backend_metrics_route ON backend_metrics(route);

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'scorecard',
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at);

-- Tracks the last time the premium-settler crank settled a given on-chain
-- policy. The crank uses this as a watermark so each call_record contributes
-- to exactly one settlement and doesn't get re-charged on subsequent cycles.
CREATE TABLE IF NOT EXISTS policy_settlements (
  policy_pda       TEXT PRIMARY KEY,
  last_settled_at  TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_pubkey TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_agent_pubkey ON api_keys(agent_pubkey);

CREATE TABLE IF NOT EXISTS claims (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_record_id  UUID NOT NULL REFERENCES call_records(id),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  agent_id        TEXT,
  policy_id       TEXT,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('timeout', 'error', 'schema_mismatch', 'latency_sla')),
  call_cost       BIGINT,
  refund_pct      INTEGER NOT NULL,
  refund_amount   BIGINT,
  status          TEXT NOT NULL DEFAULT 'simulated' CHECK (status IN ('detected', 'simulated', 'submitted', 'settled')),
  tx_hash         TEXT,
  settlement_slot BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claims_provider_id ON claims(provider_id);
CREATE INDEX IF NOT EXISTS idx_claims_agent_id ON claims(agent_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_created_at ON claims(created_at);
