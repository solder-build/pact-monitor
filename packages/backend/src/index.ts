import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { initDb } from "./db.js";
import { healthRoutes } from "./routes/health.js";
import { recordsRoutes } from "./routes/records.js";
import { providersRoutes } from "./routes/providers.js";
import { monitorRoutes } from "./routes/monitor.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { claimsRoutes } from "./routes/claims.js";
import { adminRoutes } from "./routes/admin.js";
import { metricsHook } from "./middleware/metrics.js";

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
await app.register(adminRoutes);

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
