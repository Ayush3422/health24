import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadEnv } from '../src/config/load-env';

loadEnv();

/**
 * Creates and migrates a dedicated test database once per run.
 *
 * A separate database rather than the development one, because these suites
 * truncate tables between tests. Pointing that at the database someone is
 * developing against would be a bad afternoon, and the guard rails that make
 * `db:clean` safe do not apply to a truncate.
 */
export const TEST_DATABASE = 'health24_test';

function adminUrlFor(database: string): string {
  const base = process.env.DATABASE_ADMIN_URL;

  if (!base) {
    throw new Error('DATABASE_ADMIN_URL is not set — integration tests need the owner connection');
  }

  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

export function testAppUrl(): string {
  const base = process.env.DATABASE_URL;

  if (!base) {
    throw new Error('DATABASE_URL is not set');
  }

  const url = new URL(base);
  url.pathname = `/${TEST_DATABASE}`;
  return url.toString();
}

export default async function setup(): Promise<void> {
  // Connect to the default database to create the test one.
  const maintenance = postgres(adminUrlFor('postgres'), { max: 1, onnotice: () => {} });

  try {
    const existing = await maintenance`
      SELECT 1 FROM pg_database WHERE datname = ${TEST_DATABASE}
    `;

    if (existing.length === 0) {
      await maintenance.unsafe(`CREATE DATABASE ${TEST_DATABASE}`);
      console.log(`Created ${TEST_DATABASE}`);
    }
  } finally {
    await maintenance.end({ timeout: 5 });
  }

  // Migrations run as the owner. They also create the health24_app privilege
  // group and its grants, which are per-database — so this is what makes row
  // level security bind in the test database too.
  const admin = postgres(adminUrlFor(TEST_DATABASE), { max: 1, onnotice: () => {} });

  try {
    await migrate(drizzle(admin), {
      migrationsFolder: path.resolve(__dirname, '..', 'drizzle'),
    });

    // The login role is cluster-wide and created by db:bootstrap, but its
    // membership grant must be present for this database's privileges.
    const loginRole = process.env.LOCAL_APP_DB_USER ?? 'health24_api';
    const roleExists = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${loginRole}`;

    if (roleExists.length === 0) {
      throw new Error(`Login role ${loginRole} does not exist. Run: pnpm db:bootstrap`);
    }

    await admin.unsafe(`GRANT health24_app TO ${loginRole}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
