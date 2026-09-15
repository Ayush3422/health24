import { Controller, Get } from '@nestjs/common';
import type { PortalSummary } from '@health24/shared';
import type { PatientActor, RequestMeta } from '../../common/actor';
import { CurrentMeta, CurrentPatient, PortalRoute } from '../../common/decorators';
import { PortalRecordService } from './portal-record.service';

/** The patient's own record, in the portal (SP5). */
@Controller('portal')
export class PortalRecordController {
  constructor(private readonly record: PortalRecordService) {}

  @PortalRoute()
  @Get('summary')
  async summary(
    @CurrentPatient() patient: PatientActor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PortalSummary> {
    return this.record.summary(patient, meta);
  }
}
