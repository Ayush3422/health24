import { Controller, Get } from '@nestjs/common';
import type { ClinicianOption } from '@health24/shared';
import { CurrentActor, RequirePermission } from '../../common/decorators';
import type { Actor } from '../../common/actor';
import { CliniciansService } from './clinicians.service';

@Controller('clinicians')
export class CliniciansController {
  constructor(private readonly clinicians: CliniciansService) {}

  /** For choosing whose name a transcribed entry goes in. Names and systems only. */
  @Get()
  @RequirePermission('clinical:read')
  async list(@CurrentActor() actor: Actor): Promise<ClinicianOption[]> {
    return this.clinicians.list(actor);
  }
}
