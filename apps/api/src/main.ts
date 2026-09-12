import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { loadEnv } from './config/load-env';

loadEnv();

async function bootstrap(): Promise<void> {
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Body size is capped low: this API takes JSON, not files. Uploads get
    // presigned URLs straight to object storage in SP4.
    bodyParser: true,
  });

  app.use(helmet());

  // Behind a load balancer, the client IP arrives in X-Forwarded-For. Without
  // this, every audit row records the balancer's address.
  app.set('trust proxy', 1);

  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:5173'],
    credentials: true,
  });

  // Stops in-flight requests from being cut off mid-transaction on deploy.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  Logger.log(`Health24 API listening on http://localhost:${port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error('Failed to start', error instanceof Error ? error.stack : String(error), 'Bootstrap');
  process.exit(1);
});
