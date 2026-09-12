import postgres from 'postgres';
import { loadEnv } from '../config/load-env';

loadEnv();

/**
 * Creates the local development login role.
 *
 * The application must not connect as the database owner: owners and
 * superusers bypass row-level security, which would make tenant isolation
 * decorative. Migration 0002 creates the `health24_app` privilege group; this
 * script creates a login role for local development and grants it membership.
 *
 * In a deployed environment the login role is created by whoever provisions
 * the database, with a real password, and this script is never run. That is
 * why the credential lives here and not in a migration.
 */
async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;

  if (!adminUrl) {
    throw new Error('DATABASE_ADMIN_URL is not set (the owner connection)');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the local bootstrap in production');
  }

  const loginRole = process.env.LOCAL_APP_DB_USER ?? 'health24_api';
  const loginPassword = process.env.LOCAL_APP_DB_PASSWORD ?? 'health24_local_dev';

  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });

  try {
    const existing = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${loginRole}`;

    if (existing.length === 0) {
      // Identifiers cannot be parameterised, so they are validated rather than
      // interpolated blindly.
      if (!/^[a-z_][a-z0-9_]*$/.test(loginRole)) {
        throw new Error(`Unsafe role name: ${loginRole}`);
      }
      const escapedPassword = loginPassword.replace(/'/g, "''");
      await sql.unsafe(`CREATE ROLE ${loginRole} LOGIN PASSWORD '${escapedPassword}'`);
      console.log(`Created login role ${loginRole}`);
    } else {
      console.log(`Login role ${loginRole} already exists`);
    }

    await sql.unsafe(`GRANT health24_app TO ${loginRole}`);
    console.log(`Granted health24_app to ${loginRole}`);

    // Confirm the thing that actually matters.
    const [check] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${loginRole}
    `;

    if (check?.rolsuper || check?.rolbypassrls) {
      throw new Error(
        `${loginRole} is a superuser or has BYPASSRLS — row-level security would not apply`,
      );
    }

    console.log(`${loginRole} is unprivileged; row-level security will bind to it.`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error('Bootstrap failed:', error);
  process.exitCode = 1;
});
