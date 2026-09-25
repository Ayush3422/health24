import { Controller, Get, Header, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Public } from '../common/decorators';
import { DatabaseModule } from '../db/database.module';
import { StorageModule } from '../modules/storage/storage.module';
import { HealthController } from './health.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsModule } from './metrics.module';
import { MetricsService } from './metrics.service';
import { ReadinessService } from './readiness.service';

/**
 * The routes that sit outside the `/api/v1` prefix, because a load balancer
 * and a metrics scraper are not versioned API clients. Exported so that the
 * application and the test harness cannot disagree about them.
 */
export const PROBE_ROUTES = ['health', 'ready', 'version', 'metrics'];

/**
 * What the outside world can ask about this process, and nothing else
 * (sp7-plan.md, T8, T9).
 */
@Controller()
class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Scraped, not read by a person. Public like the probes: it holds counts by
   * route and status, and — by construction — nothing about a patient.
   */
  @Public()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}

@Module({
  imports: [DatabaseModule, StorageModule, MetricsModule],
  controllers: [HealthController, MetricsController],
  providers: [ReadinessService, { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }],
})
export class HealthModule {}
