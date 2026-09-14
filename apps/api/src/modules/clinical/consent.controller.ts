import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  breakGlassSchema,
  recordConsentSchema,
  reviewBreakGlassSchema,
  revokeConsentSchema,
  type BreakGlassInput,
  type BreakGlassReviewItem,
  type ConsentSummary,
  type RecordConsentInput,
  type ReviewBreakGlassInput,
  type RevokeConsentInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { ConsentService } from './consent.service';

@Controller()
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  /** Consent for this hospital to see the patient's history elsewhere, given in person. */
  @Post('patients/:patientId/consents')
  @RequirePermission('consent:record')
  async record(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body(zodBody(recordConsentSchema)) body: RecordConsentInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ConsentSummary> {
    return this.consent.record(actor, patientId, body, meta);
  }

  @Get('patients/:patientId/consents')
  @RequirePermission('consent:read')
  async list(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ConsentSummary[]> {
    return this.consent.list(actor, patientId, meta);
  }

  /** Takes effect at once: the next read no longer sees what the consent covered. */
  @Post('consents/:id/revoke')
  @HttpCode(200)
  @RequirePermission('consent:record')
  async revoke(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(revokeConsentSchema)) body: RevokeConsentInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ConsentSummary> {
    return this.consent.revoke(actor, id, body.reason, meta);
  }

  @Post('patients/:patientId/break-glass')
  @RequirePermission('consent:break_glass')
  async breakGlass(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body(zodBody(breakGlassSchema)) body: BreakGlassInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ConsentSummary> {
    return this.consent.breakGlass(actor, patientId, body, meta);
  }

  @Get('break-glass/reviews')
  @RequirePermission('consent:review')
  async reviewQueue(
    @CurrentActor() actor: Actor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<BreakGlassReviewItem[]> {
    return this.consent.reviewQueue(actor, meta);
  }

  @Post('consents/:id/review')
  @HttpCode(200)
  @RequirePermission('consent:review')
  async review(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(reviewBreakGlassSchema)) body: ReviewBreakGlassInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ConsentSummary> {
    return this.consent.review(actor, id, body, meta);
  }
}
