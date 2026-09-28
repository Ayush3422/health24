import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import type { AbdmTransferStatus } from '@health24/shared';
import { redisConnection } from '../../scanning/scan-queue';
import { DEFAULT_TRANSFER_QUEUE, type TransferJob } from './transfer-queue';
import { TransferService } from './transfer.service';

const EVERY_FIVE_MINUTES_MS = 5 * 60 * 1000;

export function createTransferWorker(options: {
  transfers: TransferService;
  redisUrl: string;
  queueName?: string;
}): Worker<TransferJob, AbdmTransferStatus> {
  return new Worker<TransferJob, AbdmTransferStatus>(
    options.queueName ?? DEFAULT_TRANSFER_QUEUE,
    (job) => options.transfers.transfer(job.data.dataRequestId),
    // One at a time: a transfer holds a database context open while it reads
    // a record, and there is nothing to be gained by racing them.
    { connection: redisConnection(options.redisUrl), concurrency: 1 },
  );
}

/**
 * Makes the transfers, in the worker process, and sweeps behind itself
 * (sp8-plan.md, T23, DF8).
 *
 * The sweep is the half that matters. A job can be lost — Redis restarts,
 * a process is killed between the write and the enqueue — and a data request
 * left pending is a requester waiting for records that will never come, with
 * nothing to say so. Every five minutes anything still pending and older than
 * a few minutes is transferred, whether or not its job ever ran.
 */
@Injectable()
export class TransferWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TransferWorker.name);
  private worker: Worker<TransferJob, AbdmTransferStatus> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly transfers: TransferService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = createTransferWorker({
      transfers: this.transfers,
      redisUrl: this.config.getOrThrow<string>('REDIS_URL'),
      queueName: this.config.get<string>('ABDM_TRANSFER_QUEUE_NAME') ?? DEFAULT_TRANSFER_QUEUE,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Transfer ${job?.data.dataRequestId ?? 'unknown'} failed: ${error.message}`,
      );
    });

    this.timer = setInterval(() => {
      void this.sweep();
    }, EVERY_FIVE_MINUTES_MS);

    this.timer.unref?.();
  }

  /** Anything still pending that nothing picked up. */
  async sweep(): Promise<number> {
    const stranded = await this.transfers.stranded();

    for (const id of stranded) {
      this.logger.warn(`Transfer ${id} was never made; taking it on`);
      await this.transfers.transfer(id);
    }

    return stranded.length;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
  }
}
