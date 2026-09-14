import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../src/config/env';
import { loadEnv } from '../src/config/load-env';
import { ping } from '../src/modules/scanning/clamd';
import { ScanningModule } from '../src/modules/scanning/scanning.module';
import { documentFileKey } from '../src/modules/storage/keys';
import { StorageModule } from '../src/modules/storage/storage.module';

loadEnv();

/** The test bucket and queue, apart from anything a developer is using locally. */
export const TEST_BUCKET = 'health24-documents-test';

/** Storage and scanning without the rest of the application or its database. */
export async function createStorageContext(options: { queueName?: string } = {}) {
  process.env.STORAGE_BUCKET = TEST_BUCKET;
  if (options.queueName) process.env.SCAN_QUEUE_NAME = options.queueName;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateEnv }),
      StorageModule,
      ScanningModule,
    ],
  }).compile();

  await moduleRef.init();
  return moduleRef;
}

export const newFileKey = () =>
  documentFileKey({
    hospitalId: randomUUID(),
    patientId: randomUUID(),
    documentId: randomUUID(),
    fileId: randomUUID(),
  });

/**
 * The EICAR antivirus test file: harmless, and detected by every scanner.
 * Kept reversed in the source so this file is not itself flagged on disk.
 */
export const EICAR = Buffer.from(
  '*H+H$!ELIF-TSET-SURIVITNA-DRADNATS-RACIE$}7)CC7)^P(45XZP\\4[PA@%P!O5X'
    .split('')
    .reverse()
    .join(''),
);

/** Waits for clamd to load its signatures — minutes on a container's first start. */
export async function waitForClamd(timeoutMs = 300_000): Promise<void> {
  const host = process.env.CLAMAV_HOST ?? 'localhost';
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await ping({ host, port })) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  throw new Error(`ClamAV did not answer on ${host}:${port}. Run: docker compose up -d clamav`);
}
