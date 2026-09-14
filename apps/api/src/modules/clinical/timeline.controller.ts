import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  timelineQuerySchema,
  type PatientSummaryCard,
  type TimelinePage,
  type TimelineQuery,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { SummaryService } from './summary.service';
import { TimelineService } from './timeline.service';

@Controller('patients/:patientId')
export class TimelineController {
  constructor(
    private readonly timeline: TimelineService,
    private readonly summary: SummaryService,
  ) {}

  @Get('timeline')
  @RequirePermission('clinical:read')
  async forPatient(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query(zodBody(timelineQuerySchema)) query: TimelineQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<TimelinePage> {
    return this.timeline.forPatient(actor, patientId, query, meta);
  }

  @Get('summary')
  @RequirePermission('clinical:read')
  async summaryCard(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<PatientSummaryCard> {
    return this.summary.forPatient(actor, patientId, meta);
  }
}
