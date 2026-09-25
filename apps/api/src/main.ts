import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
import { loadEnv } from './config/load-env';
import { PROBE_ROUTES } from './health/health.module';

loadEnv();

async function bootstrap(): Promise<void> {
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Body size is capped low: this API takes JSON, not files. Uploads get
    // presigned URLs straight to object storage in SP4.
    bodyParser: true,
    // Buffered until the logger below is in place, so that a line written
    // during startup goes through the scrubber like every other line.
    bufferLogs: true,
  });

  // One JSON line per event, with a request id, and nothing that names a
  // patient (sp7-plan.md, DF4).
  const logger = app.get(PinoLogger);
  app.useLogger(logger);

  app.use(helmet());

  // Behind a load balancer, the client IP arrives in X-Forwarded-For. Without
  // this, every audit row records the balancer's address.
  app.set('trust proxy', 1);

  app.setGlobalPrefix('api/v1', { exclude: PROBE_ROUTES });

  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:5173'],
    credentials: true,
  });

  // Stops in-flight requests from being cut off mid-transaction on deploy.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  logger.log(`Health24 API listening on port ${String(port)}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // Before the application exists there is no scrubbing logger to use, and a
  // startup failure names configuration rather than a patient.
  console.error('Failed to start', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
