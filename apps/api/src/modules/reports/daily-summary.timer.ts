import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ReportsService } from './reports.service';

const EVERY_HOUR_MS = 60 * 60 * 1000;

/**
 * Counts yesterday for every hospital, hourly, in the worker (Decision S1).
 *
 * Hourly rather than at midnight because a worker that was down at midnight
 * would otherwise leave the day uncounted until the next one, and counting a
 * finished day again is free: the row is written once and updated in place if
 * a late correction lands.
 *
 * Nothing depends on this having run. A report that meets a day nobody has
 * counted counts it there and then, so the numbers are the same either way —
 * this only means a year's report is 365 cheap rows rather than a year of
 * encounters rescanned.
 */
@Injectable()
export class DailySummaryTimer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DailySummaryTimer.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly reports: ReportsService) {}

  onApplicationBootstrap(): void {
    const run = () =>
      void this.reports
        .summariseYesterdayEverywhere()
        .then((hospitals) => {
          if (hospitals > 0) this.logger.log(`Counted yesterday for ${hospitals} hospitals`);
        })
        .catch((error: unknown) =>
          this.logger.error(`Could not count yesterday: ${String(error)}`),
        );

    this.timer = setInterval(run, EVERY_HOUR_MS);
    this.timer.unref();
    run();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
