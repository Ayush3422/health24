import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  activatePortalAccessSchema,
  revokePortalAccessSchema,
  type ActivatePortalAccessInput,
  type PortalAccessSummary,
  type RevokePortalAccessInput,
} from '@health24/shared';
import type { Actor, RequestMeta } from '../../common/actor';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import { PortalAccessService } from './portal-access.service';

/** The desk turns a patient's portal access on, and any linked hospital can turn it off (Decision J1). */
@Controller()
export class PortalAccessController {
  constructor(private readonly access: PortalAccessService) {}

  @Post('patients/:id/portal-access')
  @RequirePermission('portal:activate')
  async activate(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(activatePortalAccessSchema)) body: ActivatePortalAccessInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalAccessSummary> {
    return this.access.activate(actor, id, body, meta);
  }

  @Get('patients/:id/portal-access')
  @RequirePermission('portal:activate')
  async list(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalAccessSummary[]> {
    return this.access.list(actor, id, meta);
  }

  @Post('portal-access/:id/revoke')
  @HttpCode(200)
  @RequirePermission('portal:activate')
  async revoke(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(revokePortalAccessSchema)) body: RevokePortalAccessInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalAccessSummary> {
    return this.access.revoke(actor, id, body.reason, meta);
  }
}
