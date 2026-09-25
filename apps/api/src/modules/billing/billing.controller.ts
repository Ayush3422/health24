import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  captureChargeSchema,
  catalogueItemInputSchema,
  catalogueQuerySchema,
  repriceItemSchema,
  retireItemSchema,
  voidChargeSchema,
  type CaptureChargeInput,
  type Catalogue,
  type CatalogueItem,
  type CatalogueItemInput,
  type CatalogueQuery,
  type Charge,
  type EncounterCharges,
  type RepriceItemInput,
  type RetireItemInput,
  type VoidChargeInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { CatalogueService } from './catalogue.service';
import { ChargesService } from './charges.service';

/**
 * The catalogue (sp6-plan.md, Phase 6). What the hospital charges for, and
 * what it costs, is its administrator's; anyone who bills may read it.
 */
@Controller()
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Post('catalogue')
  @RequirePermission('catalogue:manage')
  async add(
    @CurrentActor() actor: Actor,
    @Body(zodBody(catalogueItemInputSchema)) body: CatalogueItemInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CatalogueItem> {
    return this.catalogue.add(actor, body, meta);
  }

  @Post('catalogue/:id/reprice')
  @RequirePermission('catalogue:manage')
  async reprice(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(repriceItemSchema)) body: RepriceItemInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CatalogueItem> {
    return this.catalogue.reprice(actor, id, body, meta);
  }

  @Post('catalogue/:id/retire')
  @HttpCode(200)
  @RequirePermission('catalogue:manage')
  async retire(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(retireItemSchema)) body: RetireItemInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<CatalogueItem> {
    return this.catalogue.retire(actor, id, body, meta);
  }

  @Get('catalogue')
  @RequirePermission('catalogue:manage', 'charges:capture')
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodBody(catalogueQuerySchema)) query: CatalogueQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Catalogue> {
    return this.catalogue.list(actor, query, meta);
  }
}

/** Charges: put together at the desk, item by item, from the hospital's own prices. */
@Controller()
export class ChargesController {
  constructor(private readonly charges: ChargesService) {}

  @Post('charges')
  @RequirePermission('charges:capture')
  async capture(
    @CurrentActor() actor: Actor,
    @Body(zodBody(captureChargeSchema)) body: CaptureChargeInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Charge> {
    return this.charges.capture(actor, body, meta);
  }

  @Post('charges/:id/void')
  @HttpCode(200)
  @RequirePermission('charges:capture')
  async void(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(voidChargeSchema)) body: VoidChargeInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Charge> {
    return this.charges.void(actor, id, body, meta);
  }

  @Get('encounters/:id/charges')
  @RequirePermission('charges:capture')
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<EncounterCharges> {
    return this.charges.forEncounter(actor, id, meta);
  }
}
