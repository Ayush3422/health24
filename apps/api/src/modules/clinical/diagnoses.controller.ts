import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  recordDiagnosisSchema,
  type ConditionSummary,
  type ProblemList,
  type RecordDiagnosisInput,
  type RecordedDiagnosis,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { DiagnosesService } from './diagnoses.service';

@Controller()
export class DiagnosesController {
  constructor(private readonly diagnoses: DiagnosesService) {}

  @Post('diagnoses')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async record(
    @CurrentActor() actor: Actor,
    @Body(zodBody(recordDiagnosisSchema)) body: RecordDiagnosisInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<RecordedDiagnosis> {
    return this.diagnoses.record(actor, body, meta);
  }

  @Get('encounters/:id/diagnoses')
  @RequirePermission('clinical:read')
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ConditionSummary[]> {
    return this.diagnoses.forEncounter(actor, id, meta);
  }

  @Get('patients/:patientId/problems')
  @RequirePermission('clinical:read')
  async problemList(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ProblemList> {
    return this.diagnoses.problemList(actor, patientId, meta);
  }
}
