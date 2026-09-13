import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  correctPrescriptionSchema,
  prescribeSchema,
  stopPrescriptionSchema,
  type CorrectPrescriptionInput,
  type CurrentMedications,
  type MedicationSummary,
  type PrescribeInput,
  type PrescriptionResult,
  type StopPrescriptionInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { PrescriptionsService } from './prescriptions.service';

@Controller()
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  /** 409 with `code: ALLERGY_MATCH` when a recorded allergy matches and no override is given. */
  @Post('prescriptions')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async prescribe(
    @CurrentActor() actor: Actor,
    @Body(zodBody(prescribeSchema)) body: PrescribeInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PrescriptionResult> {
    return this.prescriptions.prescribe(actor, body, meta);
  }

  /** A new version replaces the prescription, checked against allergies afresh. */
  @Post('prescriptions/:id/correct')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async correct(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(correctPrescriptionSchema)) body: CorrectPrescriptionInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PrescriptionResult> {
    return this.prescriptions.correct(actor, id, body, meta);
  }

  /** Clinicians only: stopping a medicine is a new clinical decision, not transcription. */
  @Post('prescriptions/:id/stop')
  @HttpCode(200)
  @RequirePermission('clinical:write')
  async stop(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(stopPrescriptionSchema)) body: StopPrescriptionInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<MedicationSummary> {
    return this.prescriptions.stop(actor, id, body.reason, meta);
  }

  @Get('encounters/:id/prescriptions')
  @RequirePermission('clinical:read')
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<MedicationSummary[]> {
    return this.prescriptions.forEncounter(actor, id, meta);
  }

  @Get('patients/:patientId/medications')
  @RequirePermission('clinical:read')
  async current(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CurrentMedications> {
    return this.prescriptions.current(actor, patientId, meta);
  }
}
