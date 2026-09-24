import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  advanceOrderSchema,
  cancelOrderSchema,
  placeOrderSchema,
  worklistQuerySchema,
  type AdvanceOrderInput,
  type CancelOrderInput,
  type OrderList,
  type OrderSummary,
  type PlaceOrderInput,
  type Worklist,
  type WorklistQuery,
} from '@health24/shared';
import { CurrentActor, CurrentMeta, RequirePermission } from '../../common/decorators';
import { zodBody } from '../../common/zod-validation.pipe';
import type { Actor, RequestMeta } from '../../common/actor';
import { OrdersService } from './orders.service';

/**
 * Orders (sp6-plan.md, Phase 1). Ordering is a clinical decision, so it needs
 * a clinician's permission — or records staff transcribing in one's name.
 * Moving an order along is the work itself, which the desk and the lab do.
 */
@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('orders')
  @RequirePermission('orders:place')
  async place(
    @CurrentActor() actor: Actor,
    @Body(zodBody(placeOrderSchema)) body: PlaceOrderInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<OrderSummary> {
    return this.orders.place(actor, body, meta);
  }

  @Post('orders/:id/advance')
  @HttpCode(200)
  @RequirePermission('orders:fulfil')
  async advance(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(advanceOrderSchema)) body: AdvanceOrderInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<OrderSummary> {
    return this.orders.advance(actor, id, body, meta);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @RequirePermission('orders:place')
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(cancelOrderSchema)) body: CancelOrderInput,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<OrderSummary> {
    return this.orders.cancel(actor, id, body, meta);
  }

  /** The lab's and the radiology desk's list of what is still outstanding. */
  @Get('orders')
  @RequirePermission('orders:fulfil')
  async worklist(
    @CurrentActor() actor: Actor,
    @Query(zodBody(worklistQuerySchema)) query: WorklistQuery,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<Worklist> {
    return this.orders.worklist(actor, query, meta);
  }

  @Get('encounters/:id/orders')
  @RequirePermission('clinical:read')
  async forEncounter(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<OrderSummary[]> {
    return this.orders.forEncounter(actor, id, meta);
  }

  @Get('patients/:patientId/orders')
  @RequirePermission('clinical:read')
  async forPatient(
    @CurrentActor() actor: Actor,
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentMeta() meta: RequestMeta,
  ): Promise<OrderList> {
    return this.orders.forPatient(actor, patientId, meta);
  }
}
