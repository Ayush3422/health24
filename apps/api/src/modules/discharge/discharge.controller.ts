import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  composeDischargeSchema,
  editDischargeSchema,
  signDischargeSchema,
  type ComposeDischargeInput,
  type DischargeSummary,
  type EditDischargeInput,
  type SignDischargeInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { DischargeService } from './discharge.service';

/**
 * The discharge summary (sp6-plan.md, Phase 5).
 *
 * Composing and editing are work on a draft, which records staff may do for a
 * clinician as they do everything else. Signing is a clinical statement and
 * needs `clinical:write`; the service refuses it either way.
 */
@Controller()
export class DischargeController {
  constructor(private readonly discharge: DischargeService) {}

  @Post('discharge-summaries')
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async compose(
    @CurrentActor() actor: Actor,
    @Body(zodBody(composeDischargeSchema)) body: ComposeDischargeInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DischargeSummary> {
    return this.discharge.compose(actor, body, meta);
  }

  @Post('discharge-summaries/:id')
  @HttpCode(200)
  @RequirePermission('clinical:write', 'clinical:transcribe')
  async edit(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(editDischargeSchema)) body: EditDischargeInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DischargeSummary> {
    return this.discharge.edit(actor, id, body, meta);
  }

  @Post('discharge-summaries/:id/sign')
  @HttpCode(200)
  @RequirePermission('clinical:write')
  async sign(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(signDischargeSchema)) _body: SignDischargeInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DischargeSummary> {
    return this.discharge.sign(actor, id, meta);
  }

  @Get('encounters/:id/discharge-summary')
  @RequirePermission('clinical:read')
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<DischargeSummary> {
    return this.discharge.forEncounter(actor, id, meta);
  }
}
