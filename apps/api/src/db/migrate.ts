import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadEnv } from '../config/load-env';

loadEnv();

/**
 * Applies pending migrations and exits.
 *
 * Run as a separate step from application start, never on boot: a clinical API
 * that migrates its own database on startup will, sooner or later, migrate
 * production from a developer's laptop.
 */
async function main(): Promise<void> {
  // Migrations run as the owner. The application's own unprivileged role
  // cannot create tables, and must not be able to.
  const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('Neither DATABASE_ADMIN_URL nor DATABASE_URL is set');
  }

  // A single connection, no pooling: migrations must not run concurrently.
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  const migrationsFolder = path.resolve(__dirname, '../../drizzle');

  console.log(`Applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log('Migrations applied.');

  await client.end();
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
