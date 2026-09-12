import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  deactivateStaffSchema,
  inviteStaffSchema,
  updateStaffSchema,
  type DeactivateStaffInput,
  type InviteStaffInput,
  type StaffInviteResult,
  type StaffSummary,
  type UpdateStaffInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { StaffService } from './staff.service';

@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Post('invite')
  @RequirePermission('staff:invite')
  async invite(
    @CurrentActor() actor: Actor,
    @Body(zodBody(inviteStaffSchema)) body: InviteStaffInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StaffInviteResult> {
    return this.staff.invite(actor, body, meta);
  }

  @Get()
  @RequirePermission('staff:read')
  async list(
    @CurrentActor() actor: Actor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StaffSummary[]> {
    return this.staff.list(actor, meta);
  }

  @Get(':id')
  @RequirePermission('staff:read')
  async findById(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StaffSummary> {
    return this.staff.findById(actor, id, meta);
  }

  @Patch(':id')
  @RequirePermission('staff:update')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateStaffSchema)) body: UpdateStaffInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StaffSummary> {
    return this.staff.update(actor, id, body, meta);
  }

  /**
   * POST rather than DELETE: the account is not removed. Clinical records
   * reference their author forever, so staff accounts are deactivated, never
   * deleted.
   */
  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermission('staff:deactivate')
  async deactivate(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(deactivateStaffSchema)) body: DeactivateStaffInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StaffSummary> {
    return this.staff.deactivate(actor, id, body.reason, meta);
  }

  @Post(':id/reinstate')
  @HttpCode(200)
  @RequirePermission('staff:update')
  async reinstate(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<StaffSummary> {
    return this.staff.reinstate(actor, id, meta);
  }
}
