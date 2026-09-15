import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  emergencyCardSettingsSchema,
  type EmergencyCardSettings,
  type EmergencyPage,
  type PortalEmergencyCard,
  type PortalEmergencyCardState,
} from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import { CurrentMeta, CurrentPatient, PortalRoute, Public } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import { EmergencyCardService } from './emergency-card.service';

/** The patient's emergency card, managed in the portal (SP5, Decision L1). */
@Controller('portal/emergency-card')
export class PortalEmergencyCardController {
  constructor(private readonly cards: EmergencyCardService) {}

  @PortalRoute()
  @Get()
  async state(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalEmergencyCardState> {
    return this.cards.state(patient, meta);
  }

  @PortalRoute()
  @Post()
  async create(
    @CurrentPatient() patient: PatientActor,
    @Body(zodBody(emergencyCardSettingsSchema)) body: EmergencyCardSettings,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalEmergencyCard> {
    return this.cards.create(patient, body, meta);
  }

  @PortalRoute()
  @Patch()
  async update(
    @CurrentPatient() patient: PatientActor,
    @Body(zodBody(emergencyCardSettingsSchema)) body: EmergencyCardSettings,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalEmergencyCard> {
    return this.cards.update(patient, body, meta);
  }

  @PortalRoute()
  @Post('replace')
  @HttpCode(200)
  async replace(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalEmergencyCard> {
    return this.cards.replace(patient, meta);
  }

  @PortalRoute()
  @Post('revoke')
  @HttpCode(204)
  async revoke(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.cards.revoke(patient, meta);
  }
}

/**
 * The page an emergency card's QR code opens: readable by any casualty
 * department without signing in (`features.md`). Rate-limited, never cached,
 * never indexed, and every opening audited.
 */
@Controller('emergency')
export class EmergencyPageController {
  constructor(private readonly cards: EmergencyCardService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  async open(@Param('token') token: string, @CurrentMeta() meta: RequestMeta): Promise<EmergencyPage> {
    return this.cards.open(token, meta);
  }
}
