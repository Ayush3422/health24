import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * Orders for tests, images and procedures (sp6-plan.md, Phase 1).
 *
 * Exported because a result closes its order, and the services that record
 * results — typed values and uploaded reports — do that inside their own
 * transaction.
 */
@Module({
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
