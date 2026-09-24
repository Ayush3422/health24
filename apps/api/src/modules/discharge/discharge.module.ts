import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { WardsModule } from '../wards/wards.module';
import { DischargeController } from './discharge.controller';
import { DischargeService } from './discharge.service';

/**
 * The discharge summary (sp6-plan.md, Phase 5): composed from the record,
 * signed by a clinician, and written out as a note and a PDF.
 */
@Module({
  imports: [StorageModule, WardsModule],
  controllers: [DischargeController],
  providers: [DischargeService],
})
export class DischargeModule {}
