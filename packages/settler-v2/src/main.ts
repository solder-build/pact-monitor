import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Drains in-flight V2 batches on SIGTERM via Cloud Run's 10s grace window.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 8082);
}

void bootstrap();
