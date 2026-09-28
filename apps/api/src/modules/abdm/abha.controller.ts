import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  confirmAbhaVerificationSchema,
  startAbhaVerificationSchema,
  type ConfirmAbhaVerificationInput,
  type StartAbhaVerificationInput,
} from '@health24/shared';
import type { Actor, RequestMeta } from '../../common/actor';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import { AbhaService } from './abha.service';

/**
 * A patient's ABHA, and confirming it belongs to them (sp8-plan.md, T2).
 *
 * Under `patients/:id` rather than a top-level `abdm` tree, because this is a
 * fact about a patient record before it is anything to do with a protocol —
 * and because the permission that governs it is a patient permission.
 */
@Controller('patients/:patientId/abha')
export class AbhaController {
  constructor(private readonly abha: AbhaService) {}

  @Get()
  @RequirePermission('patient:read')
  async current(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.abha.currentIdentity(actor, patientId, meta);
  }

  /** Asks the registry to send the patient a code. Writes nothing. */
  @Post('verification')
  @RequirePermission('patient:abha_verify')
  async start(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body(zodBody(startAbhaVerificationSchema)) body: StartAbhaVerificationInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.abha.startVerification(actor, patientId, body, meta);
  }

  /** The patient reads the code back. This is the step that records anything. */
  @Post('verification/confirm')
  @RequirePermission('patient:abha_verify')
  async confirm(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body(zodBody(confirmAbhaVerificationSchema)) body: ConfirmAbhaVerificationInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.abha.confirmVerification(actor, patientId, body, meta);
  }
}
