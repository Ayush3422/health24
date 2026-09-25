import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';
import { configureApp } from './app-setup';
import { loadEnv } from './config/load-env';

loadEnv();

async function bootstrap(): Promise<void> {
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Parsed by `configureApp` with an explicit cap: this API takes JSON, not
    // files. Uploads go straight to object storage through a presigned URL.
    bodyParser: false,
    // Buffered until the logger below is in place, so that a line written
    // during startup goes through the scrubber like every other line.
    bufferLogs: true,
  });

  // One JSON line per event, with a request id, and nothing that names a
  // patient (sp7-plan.md, DF4).
  const logger = app.get(PinoLogger);
  app.useLogger(logger);

  // Headers, body limits, the prefix and CORS — the same call the test
  // suites make, so what is tested is what is deployed.
  configureApp(app);

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
