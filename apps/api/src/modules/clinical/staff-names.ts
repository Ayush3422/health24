import { sql, type SQL } from 'drizzle-orm';

/** Who is reading a record: a hospital's staff, or the patient in the portal. */
export type ReaderContext = 'hospital' | 'patient';

/**
 * A staff member's name, as the reader may see it.
 *
 * Staff rows belong to their hospital: staff read their own hospital's names
 * through a join. In the patient context that join finds nothing, so a patient
 * reads the names of staff at hospitals where they are registered through
 * `app.staff_name_for_patient` — a name, and nothing else about the staff member.
 */
export const staffName = (context: ReaderContext, joined: SQL, staffId: SQL): SQL =>
  context === 'patient' ? sql`app.staff_name_for_patient(${staffId})` : joined;
