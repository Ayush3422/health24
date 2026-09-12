import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  createHospitalSchema,
  updateHospitalSchema,
  type CreateHospitalInput,
  type HospitalSummary,
  type UpdateHospitalInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { HospitalsService } from './hospitals.service';

@Controller('hospitals')
export class HospitalsController {
  constructor(private readonly hospitals: HospitalsService) {}

  @Post()
  @RequirePermission('hospital:create')
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodBody(createHospitalSchema)) body: CreateHospitalInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<HospitalSummary> {
    return this.hospitals.create(actor, body, meta);
  }

  @Get()
  @RequirePermission('hospital:read:any')
  async list(
    @CurrentActor() actor: Actor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<HospitalSummary[]> {
    return this.hospitals.listAll(actor, meta);
  }

  /**
   * Declared before `:id` so the literal path wins the route match — otherwise
   * "me" is parsed as a UUID and 400s.
   */
  @Get('me')
  @RequirePermission('hospital:read:own')
  async findOwn(
    @CurrentActor() actor: Actor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<HospitalSummary> {
    return this.hospitals.findOwn(actor, meta);
  }

  @Get(':id')
  @RequirePermission('hospital:read:any')
  async findById(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<HospitalSummary> {
    return this.hospitals.findById(actor, id, meta);
  }

  /**
   * Both platform admins and hospital admins reach this route; the service
   * decides what each may change. The permission here is the looser of the
   * two, because a single route cannot carry two.
   */
  @Patch(':id')
  @RequirePermission('hospital:update:any', 'hospital:update:own')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateHospitalSchema)) body: UpdateHospitalInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<HospitalSummary> {
    return this.hospitals.update(actor, id, body, meta);
  }
}
