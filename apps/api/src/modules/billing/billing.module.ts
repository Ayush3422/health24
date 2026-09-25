import { Module } from '@nestjs/common';
import { WardsModule } from '../wards/wards.module';
import { CatalogueController, ChargesController } from './billing.controller';
import { CatalogueService } from './catalogue.service';
import { ChargesService } from './charges.service';

/**
 * The catalogue and its charges (sp6-plan.md, Phase 6). Bed-days come from the
 * stays the wards module records, which is why it is imported here.
 */
@Module({
  imports: [WardsModule],
  controllers: [CatalogueController, ChargesController],
  providers: [CatalogueService, ChargesService],
  exports: [CatalogueService, ChargesService],
})
export class BillingModule {}
