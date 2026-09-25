import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  captureChargeSchema,
  invoicesQuerySchema,
  issueInvoiceSchema,
  recordInsuranceSchema,
  recordPaymentSchema,
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
  type Invoice,
  type InvoiceList,
  type InvoicesQuery,
  type IssueInvoiceInput,
  type RecordInsuranceInput,
  type RecordPaymentInput,
  type RepriceItemInput,
  type RetireItemInput,
  type VoidChargeInput,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { CatalogueService } from './catalogue.service';
import { ChargesService } from './charges.service';
import { InvoicesService } from './invoices.service';

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

/**
 * Invoices and the money against them (sp6-plan.md, Phase 7).
 *
 * Issuing and taking money is the desk's work; the administrator may do both
 * and read what the hospital is owed. Nothing here edits anything: an invoice
 * is issued once, and the ledger is only ever added to.
 */
@Controller()
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post('invoices')
  @RequirePermission('invoices:issue')
  async issue(
    @CurrentActor() actor: Actor,
    @Body(zodBody(issueInvoiceSchema)) body: IssueInvoiceInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Invoice> {
    return this.invoices.issue(actor, body, meta);
  }

  @Post('invoices/:id/entries')
  @RequirePermission('invoices:issue')
  async record(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(recordPaymentSchema)) body: RecordPaymentInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Invoice> {
    return this.invoices.record(actor, id, body, meta);
  }

  @Post('invoices/:id/insurance')
  @RequirePermission('invoices:issue')
  async insurance(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(recordInsuranceSchema)) body: RecordInsuranceInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Invoice> {
    return this.invoices.recordInsurance(actor, id, body, meta);
  }

  /** What the hospital is still owed, oldest first. */
  @Get('invoices')
  @RequirePermission('invoices:read')
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodBody(invoicesQuerySchema)) query: InvoicesQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<InvoiceList> {
    return this.invoices.list(actor, query, meta);
  }

  @Get('invoices/:id')
  @RequirePermission('invoices:read')
  async one(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Invoice> {
    return this.invoices.findById(actor, id, meta);
  }
}
