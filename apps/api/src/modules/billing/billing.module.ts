import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { WardsModule } from '../wards/wards.module';
import { CatalogueController, ChargesController, InvoicesController } from './billing.controller';
import { CatalogueService } from './catalogue.service';
import { ChargesService } from './charges.service';
import { InvoicesService } from './invoices.service';

/**
 * The catalogue and its charges (sp6-plan.md, Phase 6). Bed-days come from the
 * stays the wards module records, which is why it is imported here.
 */
@Module({
  imports: [WardsModule, StorageModule],
  controllers: [CatalogueController, ChargesController, InvoicesController],
  providers: [CatalogueService, ChargesService, InvoicesService],
  exports: [CatalogueService, ChargesService, InvoicesService],
})
export class BillingModule {}
