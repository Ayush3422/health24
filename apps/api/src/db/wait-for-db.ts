import postgres from 'postgres';
import { loadEnv } from '../config/load-env';

loadEnv();

/**
 * Blocks until Postgres accepts queries, or gives up.
 *
 * Replaces the fixed sleep that `db:reset` used to rely on. A blind wait is
 * wrong in both directions: too short on a cold container and the migration
 * fails confusingly, too long and every reset wastes the difference. Polling
 * costs nothing and is correct on both a fast machine and a slow one.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_ADMIN_URL is not set');
  }

  const timeoutMs = Number(process.env.DB_WAIT_TIMEOUT_MS ?? 60_000);
  const startedAt = Date.now();

  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 3 });

    try {
      await sql`SELECT 1`;
      await sql.end({ timeout: 1 });
      console.log(`Database ready after ${Math.round((Date.now() - startedAt) / 100) / 10}s`);
      return;
    } catch (error) {
      lastError = error;
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  console.error(`Database did not become ready within ${timeoutMs}ms`);
  console.error(lastError);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('Wait failed:', error);
  process.exitCode = 1;
});
