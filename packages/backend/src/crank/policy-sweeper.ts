import type { FastifyInstance } from "fastify";

/**
 * Policy sweeper: no-op in MVP. In a later phase this will scan for
 * policies with revoked/zero delegation and deactivate them on-chain.
 */
export async function runPolicySweeper(app: FastifyInstance): Promise<void> {
  app.log.debug("Policy sweeper: no-op in MVP");
}
