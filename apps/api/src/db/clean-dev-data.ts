import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadEnv } from '../config/load-env';
import * as schema from './schema';

loadEnv();

/**
 * Removes the accounts and patients the smoke suites leave behind.
 *
 * Each smoke run invites staff and registers patients with unique identifiers,
 * so a development database drifts further from the seed with every run. That
 * drift is what turned a staff-count assertion from passing to failing, and it
 * makes matching behaviour harder to reason about as the table fills with
 * near-identical test people.
 *
 * Deliberately narrow: it deletes only rows whose names or emails carry the
 * test markers, never everything. A "clean" script that truncates tables is
 * one mistyped environment variable away from being a catastrophe, and this
 * one refuses to run against production regardless.
 */

const STAFF_EMAIL_PATTERNS = ['smoke.%@%', 'kavita.%@%', 'nosystem@%', 'sneaky@%'];
const PATIENT_NAME_PATTERNS = ['Ramesh Testkumar %', 'Second Patient %', 'Somebody Entirely %'];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to clean a production database');
  }

  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_ADMIN_URL is not set');
  }

  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });

  // try/finally, because without it a failed query leaves the connection open
  // and the process hangs rather than exiting with an error — which is exactly
  // what happened the first time this script hit a foreign key it had not
  // accounted for.
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.system_context', 'on', true)`);

      // Patients whose links and change history cascade are removable. Those
      // referenced by the merge log are not, and deliberately so: a merge and
      // its reversal are evidence about two real people's records, and the
      // schema restricts the delete to keep that history intact. Skipping them
      // here respects that rather than working around it.
      let patientsRemoved = 0;
      let patientsKept = 0;

      for (const pattern of PATIENT_NAME_PATTERNS) {
        const removed = await tx.execute<{ id: string }>(sql`
          DELETE FROM "patient"
           WHERE "name" LIKE ${pattern}
             AND NOT EXISTS (
               SELECT 1 FROM "patient_merge_log" l
                WHERE l."surviving_patient_id" = "patient"."id"
                   OR l."merged_patient_id" = "patient"."id"
             )
       RETURNING "id"
        `);
        patientsRemoved += removed.length;

        const kept = await tx.execute<{ count: string }>(sql`
          SELECT count(*) AS count FROM "patient" WHERE "name" LIKE ${pattern}
        `);
        patientsKept += Number(kept[0]?.count ?? 0);
      }

      let staffRemoved = 0;

      for (const pattern of STAFF_EMAIL_PATTERNS) {
        // Sessions cascade; merge decisions reference staff with ON DELETE
        // restrict, so accounts that resolved a merge are left in place rather
        // than the delete failing.
        const result = await tx.execute<{ id: string }>(sql`
        DELETE FROM "staff_user"
         WHERE "email" LIKE ${pattern}
           AND NOT EXISTS (
             SELECT 1 FROM "patient_merge_candidate" c WHERE c."resolved_by_staff_id" = "staff_user"."id"
           )
           AND NOT EXISTS (
             SELECT 1 FROM "patient_merge_log" l
              WHERE l."performed_by_staff_id" = "staff_user"."id"
                 OR l."reverted_by_staff_id" = "staff_user"."id"
           )
           AND NOT EXISTS (
             SELECT 1 FROM "patient_demographic_change" d WHERE d."changed_by_staff_id" = "staff_user"."id"
           )
     RETURNING "id"
      `);
        staffRemoved += result.length;
      }

      console.log(
        `Removed ${patientsRemoved} test patients and ${staffRemoved} test staff accounts.`,
      );

      if (patientsKept > 0) {
        console.log(
          `Kept ${patientsKept} test patient(s) referenced by the merge log — that history is evidence.`,
        );
      }

      console.log('The audit log is append-only and is deliberately left intact.');
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error('Clean failed:', error);
  process.exitCode = 1;
});
