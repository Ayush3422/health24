import { Module } from '@nestjs/common';
import { TerminologyModule } from '../terminology/terminology.module';
import { AllergiesService } from './allergies.service';
import { AllergiesController, EncountersController } from './clinical.controller';
import { DiagnosesController } from './diagnoses.controller';
import { DiagnosesService } from './diagnoses.service';
import { EncountersService } from './encounters.service';
import { PrescriptionsController } from './prescriptions.controller';
import { PrescriptionsService } from './prescriptions.service';

@Module({
  // Diagnoses are coded through TerminologyService.autoCode.
  imports: [TerminologyModule],
  controllers: [
    EncountersController,
    AllergiesController,
    DiagnosesController,
    PrescriptionsController,
  ],
  providers: [EncountersService, AllergiesService, DiagnosesService, PrescriptionsService],
})
export class ClinicalModule {}
