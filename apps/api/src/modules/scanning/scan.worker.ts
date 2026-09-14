import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import {
  DEFAULT_SCAN_QUEUE,
  redisConnection,
  type ScanJobData,
  type ScanJobResult,
} from './scan-queue';
import { ScanProcessor } from './scan.processor';

export function createScanWorker(options: {
  processor: ScanProcessor;
  redisUrl: string;
  queueName?: string;
  concurrency?: number;
}): Worker<ScanJobData, ScanJobResult> {
  return new Worker<ScanJobData, ScanJobResult>(
    options.queueName ?? DEFAULT_SCAN_QUEUE,
    (job) => options.processor.process(job.data),
    {
      connection: redisConnection(options.redisUrl),
      // clamd scans one stream per thread; a few at a time keeps it responsive.
      concurrency: options.concurrency ?? 2,
    },
  );
}

/** Runs the scan queue in the worker process — never inside the API. */
@Injectable()
export class ScanWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ScanWorker.name);
  private worker: Worker<ScanJobData, ScanJobResult> | null = null;

  constructor(
    private readonly processor: ScanProcessor,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const queueName = this.config.get<string>('SCAN_QUEUE_NAME') ?? DEFAULT_SCAN_QUEUE;

    this.worker = createScanWorker({
      processor: this.processor,
      redisUrl: this.config.getOrThrow<string>('REDIS_URL'),
      queueName,
    });

    this.worker.on('failed', (job, error) =>
      this.logger.error(`Scan of ${job?.data.key ?? 'a file'} failed: ${error.message}`),
    );

    this.logger.log(`Scanning uploads from the ${queueName} queue`);
  }

  async onApplicationShutdown(): Promise<void> {
    // Lets a scan in progress finish rather than leaving it half-done.
    await this.worker?.close();
  }
}
