import { ConfigService } from '@nestjs/config';
import { loadEnv } from '../../../config/load-env';
import { validateEnv } from '../../../config/env';
import { StorageService } from '../storage.service';

/**
 * Creates the documents bucket on the local S3-compatible server.
 *
 * Local only. In production the bucket is infrastructure — encryption,
 * versioning, the public-access block and its policy are set there, not by an
 * application that could get them wrong.
 */
async function main(): Promise<void> {
  loadEnv();
  const env = validateEnv(process.env);

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'storage:bootstrap is for local development; production buckets are infrastructure',
    );
  }

  const storage = new StorageService(new ConfigService(env));

  try {
    await storage.ensureBucket();
    console.log(`Bucket ${storage.bucket} is ready`);
  } finally {
    storage.onModuleDestroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
