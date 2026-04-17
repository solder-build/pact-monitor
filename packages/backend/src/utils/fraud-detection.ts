import { getOne, query } from "../db.js";

const OUTAGE_AGENT_THRESHOLD = 5;
const AGENT_HISTORY_DAYS = 7;

/**
 * Compute the premium loading factor based on agent vs network failure rate.
 * Returns 1.0 (no penalty), 1.5 (50% increase), or 2.5 (150% increase).
 */
export function computeLoadingFactor(
  agentFailureRate: number,
  networkFailureRate: number,
): number {
  if (agentFailureRate === 0) return 1.0;
  if (networkFailureRate === 0) return 2.5;

  const ratio = agentFailureRate / networkFailureRate;
  if (ratio <= 2) return 1.0;
  if (ratio <= 5) return 1.5;
  return 2.5;
}

/**
 * Determine if a provider is experiencing a real outage based on
 * how many established agents are reporting failures.
 */
export function isOutage(establishedAgentsReporting: number): boolean {
  return establishedAgentsReporting >= OUTAGE_AGENT_THRESHOLD;
}

/**
 * Query agent's failure rate and network failure rate for a provider
 * in the last 24 hours. Returns both rates as percentages (0-100).
 */
export async function getFailureRates(
  agentId: string,
  providerId: string,
): Promise<{ agentRate: number; networkRate: number }> {
  const result = await getOne<{ agent_failure_rate: string; network_failure_rate: string }>(
    `WITH agent_stats AS (
      SELECT COALESCE(
        COUNT(*) FILTER (WHERE classification != 'success') * 100.0 / NULLIF(COUNT(*), 0),
        0
      ) AS agent_failure_rate
      FROM call_records
      WHERE agent_id = $1 AND provider_id = $2 AND created_at > NOW() - INTERVAL '24 hours'
    ),
    network_stats AS (
      SELECT COALESCE(
        COUNT(*) FILTER (WHERE classification != 'success') * 100.0 / NULLIF(COUNT(*), 0),
        0
      ) AS network_failure_rate
      FROM call_records
      WHERE provider_id = $2 AND created_at > NOW() - INTERVAL '24 hours'
    )
    SELECT agent_failure_rate, network_failure_rate
    FROM agent_stats, network_stats`,
    [agentId, providerId],
  );
  return {
    agentRate: parseFloat(result?.agent_failure_rate ?? "0"),
    networkRate: parseFloat(result?.network_failure_rate ?? "0"),
  };
}

/**
 * Count how many established agents (7+ days old) are reporting failures
 * for a provider in the last hour.
 */
export async function countEstablishedFailingAgents(
  providerId: string,
): Promise<number> {
  const result = await getOne<{ cnt: string }>(
    `SELECT COUNT(DISTINCT cr.agent_id) AS cnt
     FROM call_records cr
     JOIN api_keys ak ON cr.agent_id = ak.label
     WHERE cr.provider_id = $1
       AND cr.classification != 'success'
       AND cr.created_at > NOW() - INTERVAL '1 hour'
       AND ak.created_at < NOW() - INTERVAL '${AGENT_HISTORY_DAYS} days'`,
    [providerId],
  );
  return parseInt(result?.cnt ?? "0", 10);
}

/**
 * Upsert the premium loading factor for an agent-provider pair.
 */
export async function upsertLoadingFactor(
  agentId: string,
  providerId: string,
  factor: number,
  reason: string,
): Promise<void> {
  await query(
    `INSERT INTO premium_adjustments (agent_id, provider_id, loading_factor, reason, calculated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (agent_id, provider_id)
     DO UPDATE SET loading_factor = $3, reason = $4, calculated_at = NOW()`,
    [agentId, providerId, factor, reason],
  );
}

/**
 * Create a flag for a suspicious agent.
 */
export async function createFlag(
  agentId: string,
  agentPubkey: string | null,
  reason: string,
  data: Record<string, unknown>,
): Promise<string> {
  const result = await getOne<{ id: string }>(
    `INSERT INTO agent_flags (agent_id, agent_pubkey, flag_reason, flag_data)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [agentId, agentPubkey, reason, JSON.stringify(data)],
  );
  return result!.id;
}

/**
 * Check if an agent currently has a pending flag.
 */
export async function hasPendingFlag(agentId: string): Promise<boolean> {
  const result = await getOne<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM agent_flags
     WHERE agent_id = $1 AND status = 'pending'`,
    [agentId],
  );
  return parseInt(result?.cnt ?? "0", 10) > 0;
}

/**
 * Record an outage event for audit trail.
 */
export async function recordOutageEvent(
  providerId: string,
  reportingAgents: number,
  networkFailureRate: number,
): Promise<void> {
  await query(
    `INSERT INTO outage_events (provider_id, reporting_agents, network_failure_rate)
     VALUES ($1, $2, $3)`,
    [providerId, reportingAgents, networkFailureRate],
  );
}

/**
 * Run anomaly detection after a record batch is processed.
 * Returns the loading factor applied (1.0 if no penalty).
 */
export async function detectAnomalies(
  agentId: string,
  agentPubkey: string | null,
  providerId: string,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<number> {
  const { agentRate, networkRate } = await getFailureRates(agentId, providerId);

  // Check for real outage first
  const establishedCount = await countEstablishedFailingAgents(providerId);
  if (isOutage(establishedCount)) {
    await recordOutageEvent(providerId, establishedCount, networkRate);
    await upsertLoadingFactor(agentId, providerId, 1.0, "outage_exempt");
    return 1.0;
  }

  const factor = computeLoadingFactor(agentRate, networkRate);

  if (factor > 1.0) {
    await upsertLoadingFactor(agentId, providerId, factor, "elevated_failure_rate");
    logger?.warn(
      { agentId, providerId, agentRate, networkRate, factor },
      "Premium penalty applied to agent",
    );
  }

  // Flag agent if factor hits maximum
  if (factor >= 2.5) {
    const alreadyFlagged = await hasPendingFlag(agentId);
    if (!alreadyFlagged) {
      await createFlag(agentId, agentPubkey, "failure_rate_spike", {
        agentRate,
        networkRate,
        ratio: networkRate > 0 ? agentRate / networkRate : Infinity,
        providerId,
      });
      logger?.warn(
        { agentId, providerId, agentRate, networkRate },
        "Agent flagged for anomalous failure rate",
      );
    }
  }

  return factor;
}
