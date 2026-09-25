import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './config/load-env';

loadEnv();

/**
 * Entry point for the worker process. Runs apart from the API so that
 * scanning a large file never slows a clinician's request.
 */
async function bootstrap(): Promise<void> {
  const { WorkerModule } = await import('./worker.module');

  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const { Logger: PinoLogger } = await import('nestjs-pino');
  const logger = app.get(PinoLogger);

  app.useLogger(logger);
  app.enableShutdownHooks();

  logger.log('Health24 worker started', 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // No scrubbing logger exists yet at this point, and a startup failure names
  // configuration rather than a patient.
  console.error('Worker failed to start', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
