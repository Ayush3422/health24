import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PatientsModule } from '../patients/patients.module';
import { CorrectionQueueController, PortalCorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';

/**
 * Corrections a patient asks for in the portal, applied by the hospital's
 * records staff through the ordinary demographic correction (SP5, Decision N1).
 */
@Module({
  imports: [AuditModule, PatientsModule],
  controllers: [PortalCorrectionsController, CorrectionQueueController],
  providers: [CorrectionsService],
  exports: [CorrectionsService],
})
export class CorrectionsModule {}
