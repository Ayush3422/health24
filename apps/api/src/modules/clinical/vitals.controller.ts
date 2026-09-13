import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  markEnteredInErrorSchema,
  recordVitalsSchema,
  type MarkEnteredInErrorInput,
  type RecordVitalsInput,
  type VitalSet,
  type VitalsList,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { VitalsService } from './vitals.service';

@Controller()
export class VitalsController {
  constructor(private readonly vitals: VitalsService) {}

  @Post('vitals')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async record(
    @CurrentActor() actor: Actor,
    @Body(zodBody(recordVitalsSchema)) body: RecordVitalsInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<VitalSet> {
    return this.vitals.record(actor, body, meta);
  }

  @Get('patients/:patientId/vitals')
  @RequirePermission('clinical:read')
  async forPatient(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<VitalsList> {
    return this.vitals.forPatient(actor, patientId, meta);
  }

  @Get('encounters/:id/vitals')
  @RequirePermission('clinical:read')
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<VitalSet[]> {
    return this.vitals.forEncounter(actor, id, meta);
  }

  /** Vitals are not corrected in place: a wrong set is marked in error and re-taken. */
  @Post('vitals/:groupId/entered-in-error')
  @HttpCode(200)
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async markEnteredInError(
    @CurrentActor() actor: Actor,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body(zodBody(markEnteredInErrorSchema)) body: MarkEnteredInErrorInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.vitals.markEnteredInError(actor, groupId, body.reason, meta);
  }
}
