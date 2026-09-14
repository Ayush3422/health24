import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  acknowledgeCodingReviewSchema,
  type AcknowledgeCodingReviewInput,
  type CodingReviewItem,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { CodingReviewService } from './coding-review.service';

@Controller('coding-reviews')
export class CodingReviewController {
  constructor(private readonly reviews: CodingReviewService) {}

  /** Clinicians only: whether a code still stands is clinical judgement. */
  @Get()
  @RequirePermission('clinical:write')
  async queue(
    @CurrentActor() actor: Actor,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CodingReviewItem[]> {
    return this.reviews.queue(actor, meta);
  }

  @Post(':conditionId/acknowledge')
  @RequirePermission('clinical:write')
  async acknowledge(
    @CurrentActor() actor: Actor,
    @Param('conditionId', ParseUUIDPipe) conditionId: string,
    @Body(zodBody(acknowledgeCodingReviewSchema)) body: AcknowledgeCodingReviewInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.reviews.acknowledge(actor, conditionId, body, meta);
  }
}
