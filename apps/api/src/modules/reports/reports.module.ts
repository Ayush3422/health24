import { Module } from '@nestjs/common';
import { MorbidityService } from './morbidity.service';
import { ReportsController, StatutoryReturnsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Reporting (sp6-plan.md, Phase 8): the hospital's own numbers, counted from
 * its own record, and the return it owes the ministry.
 *
 * Exported because the worker counts yesterday with the same service the API
 * reads through.
 */
@Module({
  controllers: [ReportsController, StatutoryReturnsController],
  providers: [ReportsService, MorbidityService],
  exports: [ReportsService],
})
export class ReportsModule {}
