import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * Counting, available everywhere (sp7-plan.md, T9).
 *
 * Global for the same reason the audit trail is: a module that has to remember
 * to import the counter is a module that will forget, and the counters that
 * matter most are in the places nobody thinks about — a failed audit write,
 * a job that will not run.
 */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
