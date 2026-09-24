import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  addBedsSchema,
  admissionsQuerySchema,
  admitSchema,
  createWardSchema,
  dischargeSchema,
  setBedStatusSchema,
  transferSchema,
  updateWardSchema,
  type AddBedsInput,
  type Admission,
  type AdmissionList,
  type AdmissionsQuery,
  type AdmitInput,
  type BedSummary,
  type CreateWardInput,
  type DischargeInput,
  type SetBedStatusInput,
  type TransferInput,
  type UpdateWardInput,
  type WardList,
  type WardSummary,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { AdmissionsService } from './admissions.service';
import { WardsService } from './wards.service';

/**
 * Wards and beds (sp6-plan.md, Phase 3). Setting them up is the hospital
 * administrator's; reading the board is for anyone who admits or rounds.
 */
@Controller()
export class WardsController {
  constructor(private readonly wards: WardsService) {}

  @Post('wards')
  @RequirePermission('wards:manage')
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodBody(createWardSchema)) body: CreateWardInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<WardSummary> {
    return this.wards.create(actor, body, meta);
  }

  @Post('wards/:id')
  @HttpCode(200)
  @RequirePermission('wards:manage')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateWardSchema)) body: UpdateWardInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<WardSummary> {
    return this.wards.update(actor, id, body, meta);
  }

  @Post('wards/:id/beds')
  @RequirePermission('wards:manage')
  async addBeds(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(addBedsSchema)) body: AddBedsInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<WardSummary> {
    return this.wards.addBeds(actor, id, body, meta);
  }

  @Post('beds/:id/status')
  @HttpCode(200)
  @RequirePermission('wards:manage')
  async setBedStatus(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(setBedStatusSchema)) body: SetBedStatusInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<BedSummary> {
    return this.wards.setBedStatus(actor, id, body, meta);
  }

  /** The bed board: every ward, its beds, and who is in them. */
  @Get('wards')
  @RequirePermission('wards:manage', 'admission:manage')
  async list(@CurrentActor() actor: Actor, @CurrentMeta() meta: RequestMeta): Promise<WardList> {
    return this.wards.list(actor, meta);
  }
}

/** Admission, transfer and discharge: the front desk's and the clinician's. */
@Controller()
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionsService) {}

  @Post('admissions')
  @RequirePermission('admission:manage')
  async admit(
    @CurrentActor() actor: Actor,
    @Body(zodBody(admitSchema)) body: AdmitInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Admission> {
    return this.admissions.admit(actor, body, meta);
  }

  @Post('admissions/:encounterId/transfer')
  @HttpCode(200)
  @RequirePermission('admission:manage')
  async transfer(
    @CurrentActor() actor: Actor,
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body(zodBody(transferSchema)) body: TransferInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Admission> {
    return this.admissions.transfer(actor, encounterId, body, meta);
  }

  @Post('admissions/:encounterId/discharge')
  @HttpCode(200)
  @RequirePermission('admission:manage')
  async discharge(
    @CurrentActor() actor: Actor,
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body(zodBody(dischargeSchema)) body: DischargeInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Admission> {
    return this.admissions.discharge(actor, encounterId, body, meta);
  }

  @Get('admissions')
  @RequirePermission('admission:manage', 'clinical:read')
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodBody(admissionsQuerySchema)) query: AdmissionsQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<AdmissionList> {
    return this.admissions.list(actor, query, meta);
  }

  @Get('admissions/:encounterId')
  @RequirePermission('admission:manage', 'clinical:read')
  async one(
    @CurrentActor() actor: Actor,
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Admission> {
    return this.admissions.findByEncounter(actor, encounterId, meta);
  }
}
