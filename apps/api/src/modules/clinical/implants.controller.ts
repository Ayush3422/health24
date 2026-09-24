import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  correctImplantSchema,
  implantSearchSchema,
  recordImplantSchema,
  type CorrectImplantInput,
  type ImplantList,
  type ImplantSearch,
  type ImplantSearchResults,
  type ImplantSummary,
  type RecordImplantInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { ImplantsService } from './implants.service';

/**
 * Implants and devices (sp6-plan.md, Phase 4). Recording one is recording the
 * operation; searching by serial or lot is what a recall notice needs, and it
 * reads clinical records, so it asks for the permission that does.
 */
@Controller()
export class ImplantsController {
  constructor(private readonly implants: ImplantsService) {}

  @Post('implants')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async record(
    @CurrentActor() actor: Actor,
    @Body(zodBody(recordImplantSchema)) body: RecordImplantInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImplantSummary> {
    return this.implants.record(actor, body, meta);
  }

  @Post('implants/:id/correct')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async correct(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(correctImplantSchema)) body: CorrectImplantInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImplantSummary> {
    return this.implants.correct(actor, id, body, meta);
  }

  /** A recall: every device of this batch, and who carries one. */
  @Get('implants')
  @RequirePermission('clinical:read')
  async search(
    @CurrentActor() actor: Actor,
    @Query(zodBody(implantSearchSchema)) query: ImplantSearch,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImplantSearchResults> {
    return this.implants.search(actor, query, meta);
  }

  @Get('encounters/:id/implants')
  @RequirePermission('clinical:read')
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImplantSummary[]> {
    return this.implants.forEncounter(actor, id, meta);
  }

  @Get('patients/:patientId/implants')
  @RequirePermission('clinical:read')
  async forPatient(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ImplantList> {
    return this.implants.forPatient(actor, patientId, meta);
  }
}
