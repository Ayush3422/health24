import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  addImportFilesSchema,
  classifyImportPagesSchema,
  excludeImportPagesSchema,
  externalClinicianQuerySchema,
  openImportBatchSchema,
  type AddImportFilesInput,
  type ClassifyImportPagesInput,
  type DocumentFileUrl,
  type ExcludeImportPagesInput,
  type ExternalClinicianNames,
  type ExternalClinicianQuery,
  type ImportBatchList,
  type ImportBatchSummary,
  type ImportFilesAdded,
  type OpenImportBatchInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { ImportsService } from './imports.service';

/** Legacy paper files: records staff and clinicians, who read what they classify (Decision E1). */
@Controller()
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post('imports')
  @RequirePermission('documents:import')
  async open(
    @CurrentActor() actor: Actor,
    @Body(zodBody(openImportBatchSchema)) body: OpenImportBatchInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    return this.imports.open(actor, body, meta);
  }

  @Get('patients/:patientId/imports')
  @RequirePermission('documents:import')
  async list(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImportBatchList> {
    return this.imports.list(actor, patientId, meta);
  }

  @Get('imports/:id')
  @RequirePermission('documents:import')
  async get(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    return this.imports.get(actor, id, meta);
  }

  /** Records the next files of the folder and returns one presigned upload per file. */
  @Post('imports/:id/files')
  @RequirePermission('documents:import')
  async addFiles(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(addImportFilesSchema)) body: AddImportFilesInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImportFilesAdded> {
    return this.imports.addFiles(actor, id, body, meta);
  }

  @Post('imports/:id/files/complete')
  @HttpCode(200)
  @RequirePermission('documents:import')
  async completeFiles(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    return this.imports.completeFiles(actor, id, meta);
  }

  @Get('imports/:id/pages/:pageId/url')
  @RequirePermission('documents:import')
  async pageUrl(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DocumentFileUrl> {
    return this.imports.pageUrl(actor, id, pageId, meta);
  }

  /** Makes one document from pages. */
  @Post('imports/:id/documents')
  @RequirePermission('documents:import')
  async classify(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(classifyImportPagesSchema)) body: ClassifyImportPagesInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    return this.imports.classify(actor, id, body, meta);
  }

  @Post('imports/:id/exclusions')
  @HttpCode(200)
  @RequirePermission('documents:import')
  async exclude(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(excludeImportPagesSchema)) body: ExcludeImportPagesInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    return this.imports.exclude(actor, id, body, meta);
  }

  @Post('imports/:id/finish')
  @HttpCode(200)
  @RequirePermission('documents:import')
  async finish(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImportBatchSummary> {
    return this.imports.finish(actor, id, meta);
  }

  /** Names of doctors without an account, as this hospital has already written them (T20). */
  @Get('external-clinicians')
  @RequirePermission('documents:upload')
  async externalClinicians(
    @CurrentActor() actor: Actor,
    @Query(zodBody(externalClinicianQuerySchema)) query: ExternalClinicianQuery,
  ): Promise<ExternalClinicianNames> {
    return this.imports.externalClinicianNames(actor, query.q);
  }
}
