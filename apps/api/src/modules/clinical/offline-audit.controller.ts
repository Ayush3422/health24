import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  offlineViewsSchema,
  type OfflineViewsInput,
  type OfflineViewsResult,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { OfflineAuditService } from './offline-audit.service';

@Controller('audit')
export class OfflineAuditController {
  constructor(private readonly offlineAudit: OfflineAuditService) {}

  /**
   * Anyone who can open a patient's record can have viewed it offline. Clinical
   * views are accepted only from roles that read clinical data.
   */
  @Post('offline-views')
  @HttpCode(200)
  @RequirePermission('patient:read')
  async record(
    @CurrentActor() actor: Actor,
    @Body(zodBody(offlineViewsSchema)) body: OfflineViewsInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<OfflineViewsResult> {
    return this.offlineAudit.record(actor, body, meta);
  }
}
