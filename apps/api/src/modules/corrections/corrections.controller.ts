import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  declineCorrectionSchema,
  requestCorrectionSchema,
  resolveCorrectionSchema,
  type CorrectionQueueItem,
  type CorrectionRequestSummary,
  type DeclineCorrectionInput,
  type PortalCorrections,
  type RequestCorrectionInput,
  type ResolveCorrectionInput,
} from '@health24/shared';
import type { Actor, PatientActor, RequestMeta } from '../../common/actor';
import {
  CurrentActor,
  CurrentMeta,
  CurrentPatient,
  PortalRoute,
  RequirePermission,
} from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import { CorrectionsService } from './corrections.service';

/** The patient asking for a correction, in the portal (SP5, Decision N1). */
@Controller('portal/corrections')
export class PortalCorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @PortalRoute()
  @Get()
  async overview(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalCorrections> {
    return this.corrections.overview(patient, meta);
  }

  @PortalRoute()
  @Post()
  async request(
    @CurrentPatient() patient: PatientActor,
    @Body(zodBody(requestCorrectionSchema)) body: RequestCorrectionInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CorrectionRequestSummary> {
    return this.corrections.request(patient, body, meta);
  }
}

/** The hospital's queue of corrections patients have asked for. */
@Controller('correction-requests')
export class CorrectionQueueController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Get()
  @RequirePermission('patient:update')
  async queue(
    @CurrentActor() actor: Actor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CorrectionQueueItem[]> {
    return this.corrections.queue(actor, meta);
  }

  @Post(':id/apply')
  @HttpCode(200)
  @RequirePermission('patient:update')
  async apply(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(resolveCorrectionSchema)) body: ResolveCorrectionInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CorrectionQueueItem> {
    return this.corrections.apply(actor, id, body.note, meta);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @RequirePermission('patient:update')
  async decline(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(declineCorrectionSchema)) body: DeclineCorrectionInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CorrectionQueueItem> {
    return this.corrections.decline(actor, id, body.note, meta);
  }
}
