import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { GuardianHandover } from './guardian-handover';

const EVERY_HOUR_MS = 60 * 60 * 1000;

/**
 * Runs the hand-over at 18 every hour, in the worker. Access has already
 * ended at midnight on the birthday; this only tidies sessions and tells the
 * young adult, so an hour's delay costs nothing.
 */
@Injectable()
export class GuardianHandoverTimer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(GuardianHandoverTimer.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly handover: GuardianHandover) {}

  onApplicationBootstrap(): void {
    const run = () =>
      void this.handover
        .handOverDue()
        .then((count) => {
          if (count > 0) this.logger.log(`Handed ${count} record(s) over at 18`);
        })
        .catch((error: unknown) => this.logger.error(`Hand-over at 18 failed: ${String(error)}`));

    this.timer = setInterval(run, EVERY_HOUR_MS);
    this.timer.unref();
    run();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
