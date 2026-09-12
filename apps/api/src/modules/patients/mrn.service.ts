import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../db/database.service';

/**
 * Allocates medical record numbers.
 *
 * An MRN is the number a hospital writes on every form, prints on every
 * wristband and says out loud on the ward. Two patients receiving the same one
 * is a clinical safety incident, not a data glitch — so allocation is a single
 * atomic statement, and the number is never reused even if registration later
 * fails.
 */
@Injectable()
export class MrnService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Reserves the next number for a hospital.
   *
   * `UPDATE ... RETURNING` increments and reads in one statement, so two
   * concurrent registrations are serialised by the row lock Postgres already
   * takes. A read-then-write would race, and the race would be rare enough to
   * survive testing and surface in production.
   *
   * Runs in system context because the hospital table is writable only there
   * — a tenant cannot be allowed to edit its own row directly, since that row
   * also carries its status.
   */
  async allocate(hospitalId: string): Promise<string> {
    const row = await this.db.asSystem(async (tx) => {
      const result = await tx.execute<{ mrn_prefix: string; mrn_sequence: number }>(sql`
        UPDATE "hospital"
           SET "mrn_sequence" = "mrn_sequence" + 1
         WHERE "id" = ${hospitalId}
     RETURNING "mrn_prefix", "mrn_sequence"
      `);

      return result[0];
    });

    if (!row) {
      throw new NotFoundException('Hospital not found');
    }

    return formatMrn(row.mrn_prefix, Number(row.mrn_sequence));
  }
}

/**
 * `SAH-000042`.
 *
 * Zero-padded to six digits so numbers sort correctly as text and line up in
 * printed lists, which is how they are actually read.
 */
export function formatMrn(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(6, '0')}`;
}
