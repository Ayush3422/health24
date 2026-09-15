import { Controller, Get, Query } from '@nestjs/common';
import {
  accessHistoryQuerySchema,
  type AccessHistoryPage,
  type AccessHistoryQuery,
  type PortalNotifications,
} from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import { CurrentMeta, CurrentPatient, PortalRoute } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import { ConsentService } from '../clinical/consent.service';
import { AccessHistoryService } from './access-history.service';

/** Who has read the patient's record, and emergency access to it (SP5, DF6 and DF10). */
@Controller('portal')
export class PortalActivityController {
  constructor(
    private readonly history: AccessHistoryService,
    private readonly consent: ConsentService,
  ) {}

  @PortalRoute()
  @Get('access-history')
  async accessHistory(
    @CurrentPatient() patient: PatientActor,
    @Query(zodBody(accessHistoryQuerySchema)) query: AccessHistoryQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<AccessHistoryPage> {
    return this.history.forOwnRecord(patient, query, meta);
  }

  @PortalRoute()
  @Get('notifications')
  async notifications(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalNotifications> {
    return this.consent.notificationsForOwnRecord(patient, meta);
  }
}
