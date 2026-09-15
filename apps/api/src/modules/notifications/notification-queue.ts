import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { redisConnection } from '../scanning/scan-queue';

export const DEFAULT_NOTIFICATION_QUEUE = 'patient-notifications';

/** How long adding a job may take before the caller gives up and leaves it to the sweep. */
const ENQUEUE_TIMEOUT_MS = 2_000;

export interface BreakGlassNotificationJob {
  consentId: string;
}

export type BreakGlassNotificationOutcome = 'sent' | 'no_phone' | 'skipped';

/**
 * Messages to patients, sent by the worker (sp5-plan.md, DF10).
 *
 * Opened on first use, like the scan queue. Adding a job never holds up the
 * request that caused it: emergency access is taken whether or not Redis
 * answers, and the worker's sweep finds any access whose patient was not told.
 */
@Injectable()
export class NotificationQueue implements OnModuleDestroy {
  readonly name: string;
  private queue: Queue<BreakGlassNotificationJob, BreakGlassNotificationOutcome> | null = null;

  constructor(private readonly config: ConfigService) {
    this.name = config.get<string>('NOTIFICATION_QUEUE_NAME') ?? DEFAULT_NOTIFICATION_QUEUE;
  }

  async breakGlassTaken(consentId: string): Promise<void> {
    this.queue ??= new Queue<BreakGlassNotificationJob, BreakGlassNotificationOutcome>(this.name, {
      connection: redisConnection(this.config.getOrThrow<string>('REDIS_URL')),
      defaultJobOptions: {
        // A provider outage is retried for about an hour and a half.
        attempts: 8,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    });

    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        // One job per emergency access, however often it is added.
        this.queue.add('break-glass', { consentId }, { jobId: `break-glass-${consentId}` }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The notification queue did not answer in time')),
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
