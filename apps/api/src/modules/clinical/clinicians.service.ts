import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ClinicianOption } from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { staffUsers } from '../../db/schema';
import { requireHospital, type Actor } from '../../common/actor';

/**
 * The clinicians an entry can be attributed to: everyone with the clinician
 * role at the caller's hospital. Deactivated clinicians are included, listed
 * after active ones, so a file written by a doctor who has since left can
 * still be transcribed in their name.
 */
@Injectable()
export class CliniciansService {
  constructor(private readonly db: DatabaseService) {}

  async list(actor: Actor): Promise<ClinicianOption[]> {
    const hospitalId = requireHospital(actor);

    return this.db.asTenant(hospitalId, (tx) =>
      tx
        .select({
          id: staffUsers.id,
          name: staffUsers.name,
          systemOfMedicine: staffUsers.systemOfMedicine,
          status: staffUsers.status,
        })
        .from(staffUsers)
        .where(and(eq(staffUsers.hospitalId, hospitalId), eq(staffUsers.role, 'clinician')))
        .orderBy(sql`${staffUsers.status} <> 'active'`, asc(staffUsers.name)),
    );
  }
}
