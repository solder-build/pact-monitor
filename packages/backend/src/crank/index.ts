import type { FastifyInstance } from "fastify";
import { runPremiumSettler } from "./premium-settler.js";
import { runRateUpdater } from "./rate-updater.js";
import { runPolicySweeper } from "./policy-sweeper.js";

const HOUR_MS = 60 * 60 * 1000;

const intervals: NodeJS.Timeout[] = [];
const timeouts: NodeJS.Timeout[] = [];

function wrap(
  app: FastifyInstance,
  name: string,
  fn: (app: FastifyInstance) => Promise<void>,
): () => void {
  return () => {
    fn(app).catch((err) => {
      app.log.error({ err, crank: name }, "Crank iteration failed");
    });
  };
}

export function startCrank(app: FastifyInstance): void {
  if (process.env.CRANK_ENABLED !== "true") {
    app.log.info("Crank disabled (CRANK_ENABLED != 'true'); skipping start");
    return;
  }

  const intervalMs = parseInt(process.env.CRANK_INTERVAL_MS || "900000", 10);
  app.log.info({ intervalMs }, "Starting crank loops");

  const settler = wrap(app, "premium-settler", runPremiumSettler);
  const rates = wrap(app, "rate-updater", runRateUpdater);
  const sweeper = wrap(app, "policy-sweeper", runPolicySweeper);

  // Stagger initial runs so they don't all hit the RPC at once.
  timeouts.push(setTimeout(settler, 5_000));
  timeouts.push(setTimeout(rates, 15_000));
  timeouts.push(setTimeout(sweeper, 30_000));

  intervals.push(setInterval(settler, intervalMs));
  intervals.push(setInterval(rates, intervalMs));
  intervals.push(setInterval(sweeper, HOUR_MS));
}

export function stopCrank(): void {
  while (intervals.length) {
    const t = intervals.pop();
    if (t) clearInterval(t);
  }
  while (timeouts.length) {
    const t = timeouts.pop();
    if (t) clearTimeout(t);
  }
}
