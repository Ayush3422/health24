import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  CORRECTABLE_KINDS,
  markEnteredInErrorSchema,
  type CorrectableKind,
  type MarkEnteredInErrorInput,
  type VersionHistoryEntry,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { CorrectionsService } from './corrections.service';

type EnteredInError = { id: string; versionStatus: 'entered_in_error' };

/**
 * Marking entries entered in error, and reading any entry's history.
 *
 * One route per kind rather than a `:kind` parameter, so each path says what
 * it changes and the authorisation suite classifies each explicitly.
 */
@Controller()
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post('diagnoses/:id/entered-in-error')
  @HttpCode(200)
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async diagnosisInError(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(markEnteredInErrorSchema)) body: MarkEnteredInErrorInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EnteredInError> {
    return this.corrections.markEnteredInError(actor, 'diagnoses', id, body.reason, meta);
  }

  @Post('prescriptions/:id/entered-in-error')
  @HttpCode(200)
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async prescriptionInError(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(markEnteredInErrorSchema)) body: MarkEnteredInErrorInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EnteredInError> {
    return this.corrections.markEnteredInError(actor, 'prescriptions', id, body.reason, meta);
  }

  @Post('allergies/:id/entered-in-error')
  @HttpCode(200)
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async allergyInError(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(markEnteredInErrorSchema)) body: MarkEnteredInErrorInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EnteredInError> {
    return this.corrections.markEnteredInError(actor, 'allergies', id, body.reason, meta);
  }

  @Post('notes/:id/entered-in-error')
  @HttpCode(200)
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async noteInError(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(markEnteredInErrorSchema)) body: MarkEnteredInErrorInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EnteredInError> {
    return this.corrections.markEnteredInError(actor, 'notes', id, body.reason, meta);
  }

  @Post('procedures/:id/entered-in-error')
  @HttpCode(200)
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async procedureInError(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(markEnteredInErrorSchema)) body: MarkEnteredInErrorInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EnteredInError> {
    return this.corrections.markEnteredInError(actor, 'procedures', id, body.reason, meta);
  }

  /** Every version of the entry, from any one of its ids. */
  @Get('clinical-history/:kind/:id')
  @RequirePermission('clinical:read')
  async history(
    @CurrentActor() actor: Actor,
    @Param('kind', zodBody(z.enum(CORRECTABLE_KINDS))) kind: CorrectableKind,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<VersionHistoryEntry[]> {
    return this.corrections.history(actor, kind, id, meta);
  }
}
