import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { TerminologyModule } from '../terminology/terminology.module';
import { AllergiesService } from './allergies.service';
import { AllergiesController, EncountersController } from './clinical.controller';
import { CliniciansController } from './clinicians.controller';
import { CliniciansService } from './clinicians.service';
import { CodingReviewController } from './coding-review.controller';
import { CodingReviewService } from './coding-review.service';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { CorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';
import { DiagnosesController } from './diagnoses.controller';
import { DiagnosesService } from './diagnoses.service';
import { EncountersService } from './encounters.service';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { OfflineAuditController } from './offline-audit.controller';
import { OfflineAuditService } from './offline-audit.service';
import { PrescriptionsController } from './prescriptions.controller';
import { PrescriptionsService } from './prescriptions.service';
import { ProceduresController } from './procedures.controller';
import { ProceduresService } from './procedures.service';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';
import { SummaryService } from './summary.service';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { VitalsController } from './vitals.controller';
import { VitalsService } from './vitals.service';

@Module({
  // Diagnoses are coded through TerminologyService.autoCode; emergency access
  // is announced to the patient through the notification queue.
  imports: [TerminologyModule, NotificationsModule],
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
    ResultsController,
    ConsentController,
    TimelineController,
    CodingReviewController,
    OfflineAuditController,
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
    ResultsService,
    ConsentService,
    TimelineService,
    SummaryService,
    CodingReviewService,
    OfflineAuditService,
  ],
  // The patient portal reads the same record through them (SP5).
  exports: [TimelineService, ResultsService, ConsentService],
})
export class ClinicalModule {}
