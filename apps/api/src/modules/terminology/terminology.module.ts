import { Module } from '@nestjs/common';
import { CurationService } from './curation.service';
import { TerminologyController } from './terminology.controller';
import { TerminologyService } from './terminology.service';

@Module({
  controllers: [TerminologyController],
  providers: [TerminologyService, CurationService],
  // Exported for SP3, where diagnoses are coded through TerminologyService.autoCode.
  exports: [TerminologyService],
})
export class TerminologyModule {}
