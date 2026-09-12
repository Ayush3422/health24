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
    // Dates and numerics come back as strings; we parse deliberately rather
    // than letting the driver guess. Clinical values must not be silently
    // coerced.
    transform: undefined,
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
 * Tenant context for row-level security.
 *
 * Every tenant-scoped query must run inside this helper. It opens a
 * transaction and sets `app.current_hospital_id` for its duration, which the
 * RLS policies read. Because it is `SET LOCAL`, the value cannot leak to the
 * next request that borrows the same pooled connection.
 *
 * The point of doing this in the database rather than with a `WHERE` clause is
 * that a forgotten `WHERE` is a silent cross-tenant data leak, whereas a
 * forgotten tenant context returns nothing at all — loud, and safe.
 */
export async function withTenant<T>(
  db: Db,
  context: { hospitalId: string | null; bypassRls?: boolean },
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (context.bypassRls) {
      // Platform-level work (migrations, seeding, terminology loads) runs as a
      // role that is not subject to RLS. Never reachable from a staff request.
      await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    }

    await tx.execute(
      sql`select set_config('app.current_hospital_id', ${context.hospitalId ?? ''}, true)`,
    );

    return fn(tx);
  });
}

export { schema };
