import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  correctProcedureSchema,
  recordProcedureSchema,
  type CorrectProcedureInput,
  type ProcedureList,
  type ProcedureSummary,
  type RecordProcedureInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { ProceduresService } from './procedures.service';

@Controller()
export class ProceduresController {
  constructor(private readonly procedures: ProceduresService) {}

  @Post('procedures')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async record(
    @CurrentActor() actor: Actor,
    @Body(zodBody(recordProcedureSchema)) body: RecordProcedureInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ProcedureSummary> {
    return this.procedures.record(actor, body, meta);
  }

  @Post('procedures/:id/correct')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async correct(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(correctProcedureSchema)) body: CorrectProcedureInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ProcedureSummary> {
    return this.procedures.correct(actor, id, body, meta);
  }

  @Get('encounters/:id/procedures')
  @RequirePermission('clinical:read')
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ProcedureSummary[]> {
    return this.procedures.forEncounter(actor, id, meta);
  }

  @Get('patients/:patientId/procedures')
  @RequirePermission('clinical:read')
  async forPatient(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ProcedureList> {
    return this.procedures.forPatient(actor, patientId, meta);
  }
}
