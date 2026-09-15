import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  documentFileUrlQuerySchema,
  listResultsQuerySchema,
  portalDocumentsQuerySchema,
  portalTimelineQuerySchema,
  resultTrendQuerySchema,
  type DocumentFileUrl,
  type DocumentFileUrlQuery,
  type DocumentList,
  type ListResultsQuery,
  type PortalDocumentsQuery,
  type PortalSummary,
  type PortalTimelineQuery,
  type ResultSetList,
  type ResultTrend,
  type ResultTrendQuery,
  type TimelinePage,
} from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import { CurrentMeta, CurrentPatient, PortalRoute } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import { ResultsService } from '../clinical/results.service';
import { TimelineService } from '../clinical/timeline.service';
import { DocumentsService } from '../documents/documents.service';
import { PortalRecordService } from './portal-record.service';

/**
 * The patient's own record, in the portal (SP5). Reads go through the same
 * services staff use, in the patient's database context, audited as the
 * patient (sp5-plan.md, DF6).
 */
@Controller('portal')
export class PortalRecordController {
  constructor(
    private readonly record: PortalRecordService,
    private readonly timelineService: TimelineService,
    private readonly documentsService: DocumentsService,
    private readonly resultsService: ResultsService,
  ) {}

  @PortalRoute()
  @Get('summary')
  async summary(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalSummary> {
    return this.record.summary(patient, meta);
  }

  @PortalRoute()
  @Get('timeline')
  async timeline(
    @CurrentPatient() patient: PatientActor,
    @Query(zodBody(portalTimelineQuerySchema)) query: PortalTimelineQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<TimelinePage> {
    return this.timelineService.forOwnRecord(patient, query, meta);
  }

  @PortalRoute()
  @Get('documents')
  async documents(
    @CurrentPatient() patient: PatientActor,
    @Query(zodBody(portalDocumentsQuerySchema)) query: PortalDocumentsQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DocumentList> {
    return this.documentsService.listForOwnRecord(patient, query, meta);
  }

  @PortalRoute()
  @Get('documents/:id/files/:fileId/url')
  async fileUrl(
    @CurrentPatient() patient: PatientActor,
    @Param('id', ParseUUIDPipe) documentId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Query(zodBody(documentFileUrlQuerySchema)) query: DocumentFileUrlQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DocumentFileUrl> {
    return this.documentsService.fileUrlForOwnRecord(
      patient,
      documentId,
      fileId,
      query.disposition,
      meta,
    );
  }

  @PortalRoute()
  @Get('results')
  async results(
    @CurrentPatient() patient: PatientActor,
    @Query(zodBody(listResultsQuerySchema)) query: ListResultsQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ResultSetList> {
    return this.resultsService.forOwnRecord(patient, query, meta);
  }

  @PortalRoute()
  @Get('results/trends')
  async trend(
    @CurrentPatient() patient: PatientActor,
    @Query(zodBody(resultTrendQuerySchema)) query: ResultTrendQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ResultTrend> {
    return this.resultsService.trendForOwnRecord(patient, query.code, meta);
  }
}
