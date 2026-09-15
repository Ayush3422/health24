import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Db = PostgresJsDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything you can run queries on — the pool, or a transaction inside it. */
export type Queryable = Db | DbTransaction;

export interface DbHandle {
  db: Db;
  client: postgres.Sql;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(databaseUrl, {
    max: options.max ?? 10,
    onnotice: () => {},
  });

  const db = drizzle(client, { schema });

  return {
    db,
    client,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

/**
 * Runs a unit of work scoped to one hospital.
 *
 * Every request-path query must go through here. It opens a transaction and
 * sets `app.current_hospital_id` for its duration, which the row-level
 * security policies read. Because it is `SET LOCAL`, the value cannot leak
 * into the next request that borrows the same pooled connection.
 *
 * The point of enforcing tenancy in the database rather than with a `WHERE`
 * clause is the failure mode. A forgotten `WHERE` is a silent cross-tenant
 * leak. A forgotten tenant context returns nothing at all — loud, and safe.
 */
export async function withTenant<T>(
  db: Db,
  hospitalId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_hospital_id', ${hospitalId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs a unit of work as a patient reading their own record (SP5).
 *
 * Sets `app.current_patient_id` and never a hospital: the read policies'
 * patient branch admits that patient's rows at every hospital, and nothing
 * else, and no write policy admits anything by it.
 */
export async function withPatient<T>(
  db: Db,
  patientId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_patient_id', ${patientId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs a unit of work outside tenant scoping.
 *
 * This is the escape hatch from row-level security, and it is deliberately
 * awkward to reach. There are exactly four legitimate uses:
 *
 *   1. Migrations and seeding.
 *   2. Pre-authentication lookups — staff sign-in, and the patient portal's
 *      sign-in and session checks (SP5) — which cannot know a tenant or a
 *      patient yet because they have not identified the caller.
 *   3. Executing a patient merge, which spans hospitals by definition.
 *   4. Platform administration — onboarding hospitals.
 *
 * Anything else calling this is a bug. `auth.spec.ts` asserts that the request
 * path never reaches it outside those cases.
 */
export async function withSystemContext<T>(
  db: Db,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_context', 'on', true)`);
    return fn(tx);
  });
}

export { schema };
