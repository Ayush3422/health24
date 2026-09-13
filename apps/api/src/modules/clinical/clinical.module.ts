import { Module } from '@nestjs/common';
import { TerminologyModule } from '../terminology/terminology.module';
import { AllergiesService } from './allergies.service';
import { AllergiesController, EncountersController } from './clinical.controller';
import { CliniciansController } from './clinicians.controller';
import { CliniciansService } from './clinicians.service';
import { CorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';
import { DiagnosesController } from './diagnoses.controller';
import { DiagnosesService } from './diagnoses.service';
import { EncountersService } from './encounters.service';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { PrescriptionsController } from './prescriptions.controller';
import { PrescriptionsService } from './prescriptions.service';
import { ProceduresController } from './procedures.controller';
import { ProceduresService } from './procedures.service';
import { VitalsController } from './vitals.controller';
import { VitalsService } from './vitals.service';

@Module({
  // Diagnoses are coded through TerminologyService.autoCode.
  imports: [TerminologyModule],
  controllers: [
    EncountersController,
    AllergiesController,
    DiagnosesController,
    PrescriptionsController,
    CliniciansController,
    VitalsController,
    NotesController,
    ProceduresController,
    CorrectionsController,
  ],
  providers: [
    EncountersService,
    AllergiesService,
    DiagnosesService,
    PrescriptionsService,
    CliniciansService,
    VitalsService,
    NotesService,
    ProceduresService,
    CorrectionsService,
  ],
})
export class ClinicalModule {}
