import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { redisConnection } from '../scanning/scan-queue';
import { BreakGlassNotifier } from './break-glass-notifier';
import {
  DEFAULT_NOTIFICATION_QUEUE,
  type BreakGlassNotificationJob,
  type BreakGlassNotificationOutcome,
} from './notification-queue';

export function createNotificationWorker(options: {
  notifier: BreakGlassNotifier;
  redisUrl: string;
  queueName?: string;
}): Worker<BreakGlassNotificationJob, BreakGlassNotificationOutcome> {
  return new Worker<BreakGlassNotificationJob, BreakGlassNotificationOutcome>(
    options.queueName ?? DEFAULT_NOTIFICATION_QUEUE,
    (job) => options.notifier.notify(job.data.consentId),
    { connection: redisConnection(options.redisUrl), concurrency: 4 },
  );
}

/** Sends patients' messages from the worker process — never inside the API. */
@Injectable()
export class NotificationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationWorker.name);
  private worker: Worker<BreakGlassNotificationJob, BreakGlassNotificationOutcome> | null = null;

  constructor(
    private readonly notifier: BreakGlassNotifier,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const queueName = this.config.get<string>('NOTIFICATION_QUEUE_NAME') ?? DEFAULT_NOTIFICATION_QUEUE;

    this.worker = createNotificationWorker({
      notifier: this.notifier,
      redisUrl: this.config.getOrThrow<string>('REDIS_URL'),
      queueName,
    });

    this.worker.on('failed', (job, error) =>
      this.logger.error(
        `Telling the patient of emergency access ${job?.data.consentId ?? ''} failed: ${error.message}`,
      ),
    );

    this.logger.log(`Sending patient notifications from the ${queueName} queue`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
