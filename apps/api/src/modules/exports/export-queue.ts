import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { redisConnection } from '../scanning/scan-queue';

export const DEFAULT_EXPORT_QUEUE = 'patient-exports';

/** How long adding a job may take before the request gives up; the sweep picks it up. */
const ENQUEUE_TIMEOUT_MS = 2_000;

export interface ExportJob {
  exportId: string;
}

export type ExportOutcome = 'built' | 'failed' | 'skipped';

/**
 * Exports waiting to be built (sp5-plan.md, Decision N1). Building a whole
 * record is the worker's work, not a request's.
 */
@Injectable()
export class ExportQueue implements OnModuleDestroy {
  readonly name: string;
  private queue: Queue<ExportJob, ExportOutcome> | null = null;

  constructor(private readonly config: ConfigService) {
    this.name = config.get<string>('EXPORT_QUEUE_NAME') ?? DEFAULT_EXPORT_QUEUE;
  }

  async requested(exportId: string): Promise<void> {
    this.queue ??= new Queue<ExportJob, ExportOutcome>(this.name, {
      connection: redisConnection(this.config.getOrThrow<string>('REDIS_URL')),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 500,
        removeOnFail: 1_000,
      },
    });

    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        this.queue.add('export', { exportId }, { jobId: `export-${exportId}` }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The export queue did not answer in time')),
            ENQUEUE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
