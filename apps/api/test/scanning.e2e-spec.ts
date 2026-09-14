import { randomUUID } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisConnection, ScanQueue } from '../src/modules/scanning/scan-queue';
import { ScanProcessor } from '../src/modules/scanning/scan.processor';
import { createScanWorker } from '../src/modules/scanning/scan.worker';
import { StorageService } from '../src/modules/storage/storage.service';
import { createStorageContext, EICAR, newFileKey, waitForClamd } from './storage-scanning';

/**
 * Every upload is scanned by ClamAV before it can be served (T3): a clean file
 * stays where it is, an infected one is moved to quarantine — directly, and
 * through the queue and a worker as the running system does it.
 */
describe('upload scanning', { timeout: 120_000 }, () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  let processor: ScanProcessor;
  const queueName = `document-scans-test-${randomUUID()}`;

  async function store(body: Buffer, contentType: string) {
    const key = newFileKey();
    const signed = await storage.presignUpload({ key, contentType, contentLength: body.length });
    const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body });
    expect(response.status).toBe(200);
    return key;
  }

  beforeAll(async () => {
    moduleRef = await createStorageContext({ queueName });
    storage = moduleRef.get(StorageService);
    processor = moduleRef.get(ScanProcessor);
    await storage.ensureBucket();
    await waitForClamd();
  }, 360_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('passes a clean file and leaves it in place', async () => {
    const key = await store(Buffer.from('%PDF-1.4\nLFT: ALT 32 U/L\n%%EOF\n'), 'application/pdf');

    expect(await processor.process({ key })).toEqual({ key, outcome: 'clean' });
    expect(await storage.describe(key)).not.toBeNull();
  });

  it('quarantines an infected file, which its key no longer reaches', async () => {
    const key = await store(EICAR, 'image/jpeg');

    const result = await processor.process({ key });

    expect(result).toMatchObject({ key, outcome: 'infected', quarantineKey: `quarantine/${key}` });
    expect(result.signature).toMatch(/eicar/i);
    expect(await storage.describe(key)).toBeNull();
    expect(await storage.describe(`quarantine/${key}`)).not.toBeNull();
  });

  it('does not retry a scan of a file that does not exist', async () => {
    await expect(processor.process({ key: newFileKey() })).rejects.toThrow(/does not exist/);
  });

  it('scans through the queue and a worker, as the running system does', async () => {
    const redisUrl = process.env.REDIS_URL!;
    const worker = createScanWorker({ processor, redisUrl, queueName });
    const events = new QueueEvents(queueName, { connection: redisConnection(redisUrl) });

    try {
      await events.waitUntilReady();

      const clean = await store(Buffer.from('\x89PNG synthetic scan'), 'image/png');
      const infected = await store(EICAR, 'application/pdf');

      const queue = moduleRef.get(ScanQueue);
      const { Job } = await import('bullmq');
      const [cleanJobId, infectedJobId] = [
        await queue.enqueue(clean),
        await queue.enqueue(infected),
      ];

      const { Queue } = await import('bullmq');
      const reader = new Queue(queueName, { connection: redisConnection(redisUrl) });

      try {
        const cleanJob = (await Job.fromId(reader, cleanJobId))!;
        const infectedJob = (await Job.fromId(reader, infectedJobId))!;

        expect(await cleanJob.waitUntilFinished(events, 60_000)).toEqual({
          key: clean,
          outcome: 'clean',
        });
        expect(await infectedJob.waitUntilFinished(events, 60_000)).toMatchObject({
          key: infected,
          outcome: 'infected',
        });
      } finally {
        await reader.close();
      }

      expect(await storage.describe(infected)).toBeNull();
    } finally {
      await events.close();
      await worker.close();
    }
  });
});
