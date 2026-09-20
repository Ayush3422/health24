import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  exportDownloadQuerySchema,
  type DataExportSummary,
  type ExportDownload,
  type ExportDownloadQuery,
} from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import { CurrentMeta, CurrentPatient, PortalRoute } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import { ExportsService } from './exports.service';

/** The patient's copy of their own record (SP5, Decision N1). */
@Controller('portal/exports')
export class PortalExportsController {
  constructor(private readonly exports: ExportsService) {}

  @PortalRoute()
  @Get()
  async list(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DataExportSummary[]> {
    return this.exports.list(patient, meta);
  }

  /** Building a whole record is work: a handful of requests an hour is plenty. */
  @PortalRoute()
  @Throttle({ default: { limit: 20, ttl: 60 * 60_000 } })
  @Post()
  async request(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DataExportSummary> {
    return this.exports.request(patient, meta);
  }

  @PortalRoute()
  @Get(':id/download')
  async download(
    @CurrentPatient() patient: PatientActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(exportDownloadQuerySchema)) query: ExportDownloadQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ExportDownload> {
    return this.exports.download(patient, id, query.format, meta);
  }
}
