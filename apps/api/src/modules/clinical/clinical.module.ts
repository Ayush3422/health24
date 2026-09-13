import { Module } from '@nestjs/common';
import { TerminologyModule } from '../terminology/terminology.module';
import { AllergiesService } from './allergies.service';
import { AllergiesController, EncountersController } from './clinical.controller';
import { CliniciansController } from './clinicians.controller';
import { CliniciansService } from './clinicians.service';
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
    CliniciansController,
  ],
  providers: [
    EncountersService,
    AllergiesService,
    DiagnosesService,
    PrescriptionsService,
    CliniciansService,
  ],
})
export class ClinicalModule {}
