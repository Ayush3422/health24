import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { BreakGlassNotifier } from './break-glass-notifier';

const EVERY_FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Finds emergency accesses whose patient was not told — the queue could not be
 * reached, every retry failed, or the patient had no portal phone and has one
 * now — and tells them, every five minutes, in the worker. Safe beside the
 * queue and in several workers: the notifier locks and skips.
 */
@Injectable()
export class NotificationSweepTimer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationSweepTimer.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly notifier: BreakGlassNotifier) {}

  onApplicationBootstrap(): void {
    const run = () =>
      void this.sweep().catch((error: unknown) =>
        this.logger.error(`Sweep of untold emergency accesses failed: ${String(error)}`),
      );

    this.timer = setInterval(run, EVERY_FIVE_MINUTES_MS);
    this.timer.unref();
    run();
  }

  private async sweep(): Promise<void> {
    for (const consentId of await this.notifier.pending()) {
      try {
        await this.notifier.notify(consentId);
      } catch (error) {
        this.logger.warn(`Could not yet tell the patient of ${consentId}: ${String(error)}`);
      }
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
