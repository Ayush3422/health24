import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  correctDocumentSchema,
  createDocumentSchema,
  documentFileUrlQuerySchema,
  listDocumentsQuerySchema,
  markDocumentInErrorSchema,
  type CorrectDocumentInput,
  type CreateDocumentInput,
  type CreatedDocument,
  type DocumentFileUrl,
  type DocumentFileUrlQuery,
  type DocumentList,
  type DocumentSummary,
  type ListDocumentsQuery,
  type MarkDocumentInErrorInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { DocumentsService } from './documents.service';

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Records the document and returns one presigned upload per file. */
  @Post('documents')
  @RequirePermission('documents:upload')
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodBody(createDocumentSchema)) body: CreateDocumentInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CreatedDocument> {
    return this.documents.create(actor, body, meta);
  }

  @Post('documents/:id/complete')
  @HttpCode(200)
  @RequirePermission('documents:upload')
  async complete(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DocumentSummary> {
    return this.documents.complete(actor, id, meta);
  }

  /** Clinicians and records staff see what consent allows; the front desk, its own uploads. */
  @Get('patients/:patientId/documents')
  @RequirePermission('clinical:read', 'documents:upload')
  async list(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query(zodBody(listDocumentsQuerySchema)) query: ListDocumentsQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DocumentList> {
    return this.documents.list(actor, patientId, query, meta);
  }

  @Get('documents/:id')
  @RequirePermission('clinical:read', 'documents:upload')
  async get(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DocumentSummary> {
    return this.documents.get(actor, id, meta);
  }

  /** Opening a report is reading a clinical record (Decision H1). */
  @Get('documents/:id/files/:fileId/url')
  @RequirePermission('clinical:read')
  async fileUrl(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Query(zodBody(documentFileUrlQuerySchema)) query: DocumentFileUrlQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DocumentFileUrl> {
    return this.documents.fileUrl(actor, id, fileId, query.disposition, meta);
  }

  @Post('documents/:id/correct')
  @RequirePermission('documents:upload')
  async correct(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(correctDocumentSchema)) body: CorrectDocumentInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DocumentSummary> {
    return this.documents.correct(actor, id, body, meta);
  }

  @Post('documents/:id/entered-in-error')
  @HttpCode(200)
  @RequirePermission('documents:upload')
  async enteredInError(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(markDocumentInErrorSchema)) body: MarkDocumentInErrorInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DocumentSummary> {
    return this.documents.markEnteredInError(actor, id, body.reason, meta);
  }
}
