import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { MergeService } from './merge.service';
import { MrnService } from './mrn.service';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';

@Module({
  controllers: [PatientsController],
  providers: [PatientsService, MatchingService, MergeService, MrnService],
  exports: [PatientsService, MatchingService],
})
export class PatientsModule {}
