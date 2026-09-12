import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  autoCodeSchema,
  conceptCodeSchema,
  proposeMappingSchema,
  reviewMappingSchema,
  reviewQueueQuerySchema,
  terminologyKeySchema,
  terminologySearchSchema,
  translateQuerySchema,
  type AutoCodeInput,
  type ProposeMappingInput,
  type ReviewMappingInput,
  type ReviewQueueQuery,
  type TerminologySearchInput,
  type TranslateQueryInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { CurationService } from './curation.service';
import { TerminologyService } from './terminology.service';

/** A named version, for resolving a code on an old record after its release was retired. */
const versionQuerySchema = z.object({ version: z.string().min(1).max(64).optional() });

@Controller('terminology')
export class TerminologyController {
  constructor(
    private readonly terminology: TerminologyService,
    private readonly curation: CurationService,
  ) {}

  // --- Reading --------------------------------------------------------------

  @Get('systems')
  @RequirePermission('terminology:read')
  async listSystems() {
    return this.terminology.listSystems();
  }

  @Get('search')
  @RequirePermission('terminology:read')
  async search(@Query(zodBody(terminologySearchSchema)) query: TerminologySearchInput) {
    return this.terminology.search(query);
  }

  @Get('systems/:key/concepts/:code')
  @RequirePermission('terminology:read')
  async lookup(
    @Param('key', zodBody(terminologyKeySchema)) key: string,
    @Param('code', zodBody(conceptCodeSchema)) code: string,
    @Query(zodBody(versionQuerySchema)) query: z.infer<typeof versionQuerySchema>,
  ) {
    return this.terminology.lookup(key, code, query.version);
  }

  @Get('translate')
  @RequirePermission('terminology:read')
  async translate(@Query(zodBody(translateQuerySchema)) query: TranslateQueryInput) {
    return this.terminology.translate(query);
  }

  /**
   * What would be attached to a diagnosis coded with this concept. A read, so
   * GET: it computes codings and stores nothing — the diagnosis that uses them
   * arrives in SP3.
   */
  @Get('auto-code')
  @RequirePermission('terminology:read')
  async autoCode(@Query(zodBody(autoCodeSchema)) query: AutoCodeInput) {
    return this.terminology.autoCode(query);
  }

  // --- Release lifecycle ----------------------------------------------------

  @Post('systems/:id/activate')
  @HttpCode(200)
  @RequirePermission('terminology:manage')
  async activate(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.terminology.activate(actor, id, meta);
  }

  // --- Curation -------------------------------------------------------------

  @Get('review-queue')
  @RequirePermission('terminology:curate')
  async queue(
    @CurrentActor() actor: Actor,
    @Query(zodBody(reviewQueueQuerySchema)) query: ReviewQueueQuery,
  ) {
    return this.curation.queue(actor, query);
  }

  @Post('map-elements')
  @RequirePermission('terminology:curate')
  async propose(
    @CurrentActor() actor: Actor,
    @Body(zodBody(proposeMappingSchema)) body: ProposeMappingInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.curation.propose(actor, body, meta);
  }

  @Post('map-elements/:id/review')
  @HttpCode(200)
  @RequirePermission('terminology:curate')
  async review(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(reviewMappingSchema)) body: ReviewMappingInput,
    @CurrentMeta() meta: RequestMeta,
  ) {
    return this.curation.review(actor, id, body, meta);
  }

  @Get('map-elements/:id/history')
  @RequirePermission('terminology:curate')
  async history(@Param('id', ParseUUIDPipe) id: string) {
    return this.curation.history(id);
  }

  @Get('coverage')
  @RequirePermission('terminology:curate', 'terminology:manage')
  async coverage() {
    return this.curation.coverage();
  }
}
