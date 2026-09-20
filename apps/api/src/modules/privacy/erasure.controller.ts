import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  decideErasureSchema,
  requestErasureSchema,
  type DecideErasureInput,
  type ErasureQueueItem,
  type ErasureRequestSummary,
  type RequestErasureInput,
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
import { ErasureService } from './erasure.service';

/** The patient asking for their data to be erased (SP5, Decision N1). */
@Controller('portal/erasure-requests')
export class PortalErasureController {
  constructor(private readonly erasure: ErasureService) {}

  @PortalRoute()
  @Get()
  async mine(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ErasureRequestSummary[]> {
    return this.erasure.mine(patient, meta);
  }

  @PortalRoute()
  @Post()
  async request(
    @CurrentPatient() patient: PatientActor,
    @Body(zodBody(requestErasureSchema)) body: RequestErasureInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ErasureRequestSummary> {
    return this.erasure.request(patient, body, meta);
  }
}

/** Health24's data-protection officer, who decides erasure requests and nothing else. */
@Controller('erasure-requests')
export class ErasureQueueController {
  constructor(private readonly erasure: ErasureService) {}

  @Get()
  @RequirePermission('privacy:review')
  async queue(
    @CurrentActor() actor: Actor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ErasureQueueItem[]> {
    return this.erasure.queue(actor, meta);
  }

  @Post(':id/decide')
  @HttpCode(200)
  @RequirePermission('privacy:review')
  async decide(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(decideErasureSchema)) body: DecideErasureInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ErasureQueueItem> {
    return this.erasure.decide(actor, id, body, meta);
  }
}
