import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../scanning/scan-queue';
import { ExportBuilder } from './export-builder';
import { DEFAULT_EXPORT_QUEUE, type ExportJob, type ExportOutcome } from './export-queue';

const EVERY_TEN_MINUTES_MS = 10 * 60 * 1000;

export function createExportWorker(options: {
  builder: ExportBuilder;
  redisUrl: string;
  queueName?: string;
}): Worker<ExportJob, ExportOutcome> {
  return new Worker<ExportJob, ExportOutcome>(
    options.queueName ?? DEFAULT_EXPORT_QUEUE,
    (job) => options.builder.build(job.data.exportId),
    { connection: redisConnection(options.redisUrl), concurrency: 2 },
  );
}

/**
 * Builds patients' exports in the worker process, and every ten minutes takes
 * on any whose job never ran and removes the files of any past their week.
 */
@Injectable()
export class ExportWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExportWorker.name);
  private worker: Worker<ExportJob, ExportOutcome> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly builder: ExportBuilder,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const queueName = this.config.get<string>('EXPORT_QUEUE_NAME') ?? DEFAULT_EXPORT_QUEUE;

    this.worker = createExportWorker({
      builder: this.builder,
      redisUrl: this.config.getOrThrow<string>('REDIS_URL'),
      queueName,
    });

    this.worker.on('failed', (job, error) =>
      this.logger.error(`Export ${job?.data.exportId ?? ''} failed: ${error.message}`),
    );

    const sweep = () => void this.sweep();
    this.timer = setInterval(sweep, EVERY_TEN_MINUTES_MS);
    this.timer.unref();
    sweep();

    this.logger.log(`Building patients' exports from the ${queueName} queue`);
  }

  private async sweep(): Promise<void> {
    try {
      for (const exportId of await this.builder.pending()) {
        await this.builder.build(exportId);
      }

      const expired = await this.builder.expireOld();
      if (expired > 0) this.logger.log(`Removed the files of ${expired} expired export(s)`);
    } catch (error) {
      this.logger.error(`Export sweep failed: ${String(error)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
  }
}
