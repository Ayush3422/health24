import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  portalGrantConsentSchema,
  portalRevokeConsentSchema,
  type PortalConsent,
  type PortalConsents,
  type PortalGrantConsentInput,
  type PortalRevokeConsentInput,
} from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import { CurrentMeta, CurrentPatient, PortalRoute } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import { ConsentService } from '../clinical/consent.service';

/** The patient's consents, granted and revoked by the patient (SP5, Decision K1). */
@Controller('portal/consents')
export class PortalConsentController {
  constructor(private readonly consent: ConsentService) {}

  @PortalRoute()
  @Get()
  async list(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalConsents> {
    return this.consent.listForOwnRecord(patient, meta);
  }

  @PortalRoute()
  @Post()
  async grant(
    @CurrentPatient() patient: PatientActor,
    @Body(zodBody(portalGrantConsentSchema)) body: PortalGrantConsentInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalConsent> {
    return this.consent.grantForOwnRecord(patient, body, meta);
  }

  /** Takes effect at once: the hospital's next read no longer sees what the consent covered. */
  @PortalRoute()
  @Post(':id/revoke')
  @HttpCode(200)
  async revoke(
    @CurrentPatient() patient: PatientActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(portalRevokeConsentSchema)) body: PortalRevokeConsentInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalConsent> {
    return this.consent.revokeForOwnRecord(patient, id, body.reason, meta);
  }
}
