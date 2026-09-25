import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  footfallQuerySchema,
  generateReturnSchema,
  reportRangeSchema,
  submitReturnSchema,
  type DataQualityReport,
  type DiagnosisReport,
  type FootfallQuery,
  type FootfallReport,
  type GenerateReturnInput,
  type PrescriptionReport,
  type ReportRange,
  type RevenueReport,
  type StatutoryReturn,
  type StatutoryReturnList,
  type SubmitReturnInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { MorbidityService } from './morbidity.service';
import { ReportsService } from './reports.service';

/**
 * The hospital's own numbers (sp6-plan.md, Phase 8).
 *
 * Every one of these counts the hospital's own record and nobody else's,
 * because the queries run under the same row-level security as the record
 * itself (DF9).
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('footfall')
  @RequirePermission('reports:read')
  async footfall(
    @CurrentActor() actor: Actor,
    @Query(zodBody(footfallQuerySchema)) query: FootfallQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<FootfallReport> {
    return this.reports.footfall(actor, query, meta);
  }

  @Get('diagnoses')
  @RequirePermission('reports:read')
  async diagnoses(
    @CurrentActor() actor: Actor,
    @Query(zodBody(reportRangeSchema)) range: ReportRange,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DiagnosisReport> {
    return this.reports.diagnoses(actor, range, meta);
  }

  @Get('prescriptions')
  @RequirePermission('reports:read')
  async prescriptions(
    @CurrentActor() actor: Actor,
    @Query(zodBody(reportRangeSchema)) range: ReportRange,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PrescriptionReport> {
    return this.reports.prescriptions(actor, range, meta);
  }

  @Get('revenue')
  @RequirePermission('reports:read')
  async revenue(
    @CurrentActor() actor: Actor,
    @Query(zodBody(reportRangeSchema)) range: ReportRange,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<RevenueReport> {
    return this.reports.revenue(actor, range, meta);
  }

  @Get('data-quality')
  @RequirePermission('reports:read')
  async dataQuality(
    @CurrentActor() actor: Actor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DataQualityReport> {
    return this.reports.dataQuality(actor, meta);
  }
}

/** The statutory return: generated, reviewed, submitted and kept (DF10). */
@Controller('statutory-returns')
export class StatutoryReturnsController {
  constructor(private readonly morbidity: MorbidityService) {}

  @Post()
  @RequirePermission('reports:submit')
  async generate(
    @CurrentActor() actor: Actor,
    @Body(zodBody(generateReturnSchema)) body: GenerateReturnInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StatutoryReturn> {
    return this.morbidity.generate(actor, body, meta);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('reports:submit')
  async submit(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(submitReturnSchema)) body: SubmitReturnInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StatutoryReturn> {
    return this.morbidity.submit(actor, id, body, meta);
  }

  @Get()
  @RequirePermission('reports:read')
  async list(
    @CurrentActor() actor: Actor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StatutoryReturnList> {
    return this.morbidity.list(actor, meta);
  }

  @Get(':id')
  @RequirePermission('reports:read')
  async one(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StatutoryReturn> {
    return this.morbidity.findById(actor, id, meta);
  }

  /** The same figures as a spreadsheet, which is how a ministry asks for them. */
  @Get(':id/csv')
  @RequirePermission('reports:read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="ayush-morbidity-return.csv"')
  async csv(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<string> {
    return this.morbidity.asCsv(actor, id, meta);
  }
}
