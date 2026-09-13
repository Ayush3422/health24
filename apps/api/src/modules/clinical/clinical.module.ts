import { Module } from '@nestjs/common';
import { AllergiesService } from './allergies.service';
import { AllergiesController, EncountersController } from './clinical.controller';
import { EncountersService } from './encounters.service';

@Module({
  controllers: [EncountersController, AllergiesController],
  providers: [EncountersService, AllergiesService],
})
export class ClinicalModule {}
