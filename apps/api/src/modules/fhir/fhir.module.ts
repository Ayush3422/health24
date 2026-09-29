import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { TerminologyModule } from '../terminology/terminology.module';
import { FhirController } from './fhir.controller';
import { FhirService } from './fhir.service';

/**
 * The `/fhir/R4` read surface (`planning.md` §10, sp8-plan.md, Phase 6).
 *
 * A translation layer over the relational model, not a second store — which
 * is why this module has no schema of its own and depends on the terminology
 * service and the export mappings rather than reproducing either.
 */
@Module({
  imports: [AuditModule, TerminologyModule],
  controllers: [FhirController],
  providers: [FhirService],
})
export class FhirModule {}
