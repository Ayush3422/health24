import { Module } from '@nestjs/common';
import { AdmissionsService } from './admissions.service';
import { AdmissionsController, WardsController } from './wards.controller';
import { WardsService } from './wards.service';

/**
 * Wards, beds and admissions (sp6-plan.md, Phase 3).
 *
 * Exported because a stay's bed-days are what Phase 6 charges for.
 */
@Module({
  controllers: [WardsController, AdmissionsController],
  providers: [WardsService, AdmissionsService],
  exports: [AdmissionsService],
})
export class WardsModule {}
