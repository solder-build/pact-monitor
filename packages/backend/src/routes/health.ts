import type { FastifyInstance } from "fastify";
import { checkConnection } from "../db.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    const dbOk = await checkConnection();
    return { status: dbOk ? "ok" : "degraded", db: dbOk ? "connected" : "disconnected" };
  });
}
