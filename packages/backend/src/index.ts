import "dotenv/config";
import Fastify from "fastify";
import { initDb } from "./db.js";
import { healthRoutes } from "./routes/health.js";
import { recordsRoutes } from "./routes/records.js";
import { providersRoutes } from "./routes/providers.js";
import { monitorRoutes } from "./routes/monitor.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { claimsRoutes } from "./routes/claims.js";

const app = Fastify({ logger: true });

await app.register(healthRoutes);
await app.register(recordsRoutes);
await app.register(providersRoutes);
await app.register(monitorRoutes);
await app.register(analyticsRoutes);
await app.register(claimsRoutes);

const port = parseInt(process.env.PORT || "3001", 10);

try {
  await initDb();
  app.log.info("Database schema initialized");
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Server running on port ${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
