import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { AbdmTransferStatus } from '@health24/shared';
import { redisConnection } from '../../scanning/scan-queue';

export const DEFAULT_TRANSFER_QUEUE = 'abdm-transfers';

/** How long adding a job may take before the request gives up. */
const ENQUEUE_TIMEOUT_MS = 2_000;

export interface TransferJob {
  dataRequestId: string;
}

/**
 * Transfers waiting to be made (sp8-plan.md, T23, DF8).
 *
 * Assembling a record, encrypting it and pushing it to another system is not
 * work to do while a gateway waits for its 202 — and it is work worth
 * retrying, because the failure that actually happens is the requester's
 * endpoint being briefly unreachable.
 *
 * The job carries an id and nothing else. Everything the transfer needs is in
 * the row it names, which means a job that is delivered twice finds the row
 * already settled and does nothing.
 */
@Injectable()
export class TransferQueue implements OnModuleDestroy {
  private readonly logger = new Logger(TransferQueue.name);
  readonly name: string;
  private queue: Queue<TransferJob, AbdmTransferStatus> | null = null;

  constructor(private readonly config: ConfigService) {
    this.name = config.get<string>('ABDM_TRANSFER_QUEUE_NAME') ?? DEFAULT_TRANSFER_QUEUE;
  }

  async requested(dataRequestId: string): Promise<void> {
    this.queue ??= new Queue<TransferJob, AbdmTransferStatus>(this.name, {
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
        this.queue.add(
          'transfer',
          { dataRequestId },
          // One job per request, so a redelivered notification does not
          // queue a second transfer of the same records.
          { jobId: `abdm-transfer-${dataRequestId}` },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The transfer queue did not answer in time')),
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
