import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  listResultsQuerySchema,
  markResultsInErrorSchema,
  recordResultsSchema,
  resultTrendQuerySchema,
  type ListResultsQuery,
  type MarkResultsInErrorInput,
  type RecordResultsInput,
  type ResultSet,
  type ResultSetList,
  type ResultTrend,
  type ResultTrendQuery,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { ResultsService } from './results.service';

@Controller()
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  /** Typed from the report in hand — by the front desk, records staff or a clinician. */
  @Post('results')
  @RequirePermission('results:enter')
  async record(
    @CurrentActor() actor: Actor,
    @Body(zodBody(recordResultsSchema)) body: RecordResultsInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ResultSet> {
    return this.results.record(actor, body, meta);
  }

  /** Reading results is reading clinical records (Decision H1). */
  @Get('patients/:patientId/results')
  @RequirePermission('clinical:read')
  async forPatient(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query(zodBody(listResultsQuerySchema)) query: ListResultsQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ResultSetList> {
    return this.results.forPatient(actor, patientId, query, meta);
  }

  @Get('patients/:patientId/results/trends')
  @RequirePermission('clinical:read')
  async trend(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query(zodBody(resultTrendQuerySchema)) query: ResultTrendQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<ResultTrend> {
    return this.results.trend(actor, patientId, query.code, meta);
  }

  @Post('results/:setId/entered-in-error')
  @HttpCode(200)
  @RequirePermission('results:enter')
  async enteredInError(
    @CurrentActor() actor: Actor,
    @Param('setId', ParseUUIDPipe) setId: string,
    @Body(zodBody(markResultsInErrorSchema)) body: MarkResultsInErrorInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.results.markEnteredInError(actor, setId, body.reason, meta);
  }
}
