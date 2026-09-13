import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  cancelEncounterSchema,
  correctAllergySchema,
  listEncountersQuerySchema,
  openEncounterSchema,
  recordAllergySchema,
  type AllergyBanner,
  type AllergySummary,
  type CancelEncounterInput,
  type CorrectAllergyInput,
  type EncounterSummary,
  type ListEncountersQuery,
  type OpenEncounterInput,
  type RecordAllergyInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { AllergiesService } from './allergies.service';
import { EncountersService } from './encounters.service';

@Controller('encounters')
export class EncountersController {
  constructor(private readonly encounters: EncountersService) {}

  @Post()
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async open(
    @CurrentActor() actor: Actor,
    @Body(zodBody(openEncounterSchema)) body: OpenEncounterInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EncounterSummary> {
    return this.encounters.open(actor, body, meta);
  }

  @Get()
  @RequirePermission('clinical:read')
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodBody(listEncountersQuerySchema)) query: ListEncountersQuery,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.encounters.list(actor, query, meta);
  }

  @Get(':id')
  @RequirePermission('clinical:read')
  async findById(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EncounterSummary> {
    return this.encounters.findById(actor, id, meta);
  }

  @Post(':id/finish')
  @HttpCode(200)
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async finish(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EncounterSummary> {
    return this.encounters.finish(actor, id, meta);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(cancelEncounterSchema)) body: CancelEncounterInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EncounterSummary> {
    return this.encounters.cancel(actor, id, body.reason, meta);
  }
}

@Controller()
export class AllergiesController {
  constructor(private readonly allergies: AllergiesService) {}

  @Post('allergies')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async record(
    @CurrentActor() actor: Actor,
    @Body(zodBody(recordAllergySchema)) body: RecordAllergyInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<AllergySummary> {
    return this.allergies.record(actor, body, meta);
  }

  /** A correction, including resolving the allergy with a new clinical status. */
  @Post('allergies/:id/correct')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async correct(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(correctAllergySchema)) body: CorrectAllergyInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<AllergySummary> {
    return this.allergies.correct(actor, id, body, meta);
  }

  /** The banner: active allergies from every record the caller may see. */
  @Get('patients/:patientId/allergies')
  @RequirePermission('clinical:read')
  async banner(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<AllergyBanner> {
    return this.allergies.banner(actor, patientId, meta);
  }
}
