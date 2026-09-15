import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import { assertStorageKey } from '../storage/keys';

export const DEFAULT_SCAN_QUEUE = 'document-scans';

export interface ScanJobData {
  key: string;
}

export interface ScanJobResult {
  key: string;
  outcome: 'clean' | 'infected';
  signature?: string;
  quarantineKey?: string;
  /** Of the stored bytes, computed while scanning. */
  sha256: string;
}

/** Runs one scan job: the processor alone, or with the verdict recorded against its document. */
export interface ScanJobHandler {
  process(data: ScanJobData): Promise<ScanJobResult>;
}

export const SCAN_JOB_HANDLER = Symbol('SCAN_JOB_HANDLER');

/** BullMQ's connection options from a redis:// URL. */
export function redisConnection(url: string): ConnectionOptions {
  const parsed = new URL(url);

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : undefined,
    // Required by BullMQ workers, which block waiting for jobs.
    maxRetriesPerRequest: null,
  };
}

/**
 * The queue of files waiting to be scanned.
 *
 * Opened on first use, so the API starts without Redis and only the upload
 * routes need it. A failed scan is retried with backoff: until a file has been
 * scanned clean it is never served, so a retry costs a wait, not safety.
 */
@Injectable()
export class ScanQueue implements OnModuleDestroy {
  readonly name: string;
  private queue: Queue<ScanJobData, ScanJobResult> | null = null;

  constructor(private readonly config: ConfigService) {
    this.name = config.get<string>('SCAN_QUEUE_NAME') ?? DEFAULT_SCAN_QUEUE;
  }

  async enqueue(key: string): Promise<string> {
    assertStorageKey(key);

    this.queue ??= new Queue<ScanJobData, ScanJobResult>(this.name, {
      connection: redisConnection(this.config.getOrThrow<string>('REDIS_URL')),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    });

    const job = await this.queue.add('scan', { key });
    return job.id!;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
