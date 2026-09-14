import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './config/load-env';

loadEnv();

/**
 * Entry point for the worker process. Runs apart from the API so that
 * scanning a large file never slows a clinician's request.
 */
async function bootstrap(): Promise<void> {
  const { WorkerModule } = await import('./worker.module');

  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  Logger.log('Health24 worker started', 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(
    'Worker failed to start',
    error instanceof Error ? error.stack : String(error),
    'Bootstrap',
  );
  process.exit(1);
});
