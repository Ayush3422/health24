import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  confirmCareContextLinkSchema,
  offerCareContextLinkSchema,
  unlinkCareContextSchema,
  type ConfirmCareContextLinkInput,
  type OfferCareContextLinkInput,
  type UnlinkCareContextInput,
} from '@health24/shared';
import type { Actor, RequestMeta } from '../../../common/actor';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../../common/decorators';
import { zodBody } from '../../../common/zod-validation.pipe';
import { LinkingService } from './linking.service';

/**
 * What the desk does about a patient's visits and the national network
 * (sp8-plan.md, T12, T13).
 *
 * Three verbs and no fourth: see what is shared, ask the patient to share
 * more, and withdraw. There is deliberately no way for a member of staff to
 * link a visit without the patient answering a code — the confirm step is not
 * a formality that could be skipped by an administrator in a hurry.
 */
@Controller('patients/:patientId/care-contexts')
export class CareContextController {
  constructor(private readonly linking: LinkingService) {}

  @Get()
  @RequirePermission('patient:read')
  async list(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.linking.listVisits(actor, patientId, meta);
  }

  /** Asks the network to send the patient a code. Links nothing. */
  @Post('link')
  @RequirePermission('abdm:link')
  async offer(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body(zodBody(offerCareContextLinkSchema)) body: OfferCareContextLinkInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.linking.offerLink(actor, patientId, body.encounterIds, meta);
  }

  /** The patient read the code out. This is the step that links anything. */
  @Post('link/confirm')
  @RequirePermission('abdm:link')
  async confirm(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body(zodBody(confirmCareContextLinkSchema)) body: ConfirmCareContextLinkInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.linking.confirmOffer(actor, patientId, body, meta);
  }

  @Post(':careContextId/unlink')
  @RequirePermission('abdm:link')
  async unlink(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) _patientId: string,
    @Param('careContextId', ParseUUIDPipe) careContextId: string,
    @Body(zodBody(unlinkCareContextSchema)) body: UnlinkCareContextInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    await this.linking.unlink(actor, careContextId, body.reason, meta);
    return { unlinked: true };
  }
}
