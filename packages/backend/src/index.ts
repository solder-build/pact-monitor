import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { Connection } from "@solana/web3.js";
import { initDb } from "./db.js";
import { healthRoutes } from "./routes/health.js";
import { recordsRoutes } from "./routes/records.js";
import { providersRoutes } from "./routes/providers.js";
import { monitorRoutes } from "./routes/monitor.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { claimsRoutes } from "./routes/claims.js";
import { claimsSubmitRoute } from "./routes/claims-submit.js";
import { poolsRoute } from "./routes/pools.js";
import { premiumRoutes } from "./routes/premium.js";
import { startCrank } from "./crank/index.js";
import { adminRoutes } from "./routes/admin.js";
import { faucetRoutes } from "./routes/faucet.js";
import { metricsHook } from "./middleware/metrics.js";
import { detectAndCacheNetwork } from "./utils/network.js";
import { getSolanaConfig } from "./utils/solana.js";

const app = Fastify({ logger: true });

app.addHook("onResponse", metricsHook);

const corsOrigins = (process.env.CORS_ORIGINS ?? "https://pactnetwork.io,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

await app.register(cors, {
  origin: corsOrigins,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
});

await app.register(healthRoutes);
await app.register(recordsRoutes);
await app.register(providersRoutes);
await app.register(monitorRoutes);
await app.register(analyticsRoutes);
await app.register(claimsRoutes);
await app.register(claimsSubmitRoute);
await app.register(poolsRoute);
await app.register(premiumRoutes);
await app.register(adminRoutes);
await app.register(faucetRoutes);

const port = parseInt(process.env.PORT || "3001", 10);

try {
  await initDb();
  app.log.info("Database schema initialized");

  // Detect which Solana cluster we're pointed at so faucet + any future
  // network-sensitive routes can short-circuit on mainnet. Genesis-hash check
  // fails closed — if RPC is unreachable we cache "unknown" and downstream
  // gates treat that the same as mainnet.
  try {
    const solanaConfig = getSolanaConfig();
    const conn = new Connection(solanaConfig.rpcUrl, "confirmed");
    const network = await detectAndCacheNetwork(conn);
    app.log.info(`Solana network detected: ${network}`);
  } catch (err) {
    app.log.warn(
      { err },
      "Solana network detection skipped (likely missing config); network-sensitive routes will fail closed",
    );
  }

  startCrank(app);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Server running on port ${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
