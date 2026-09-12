import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  appRoleDb,
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * Row-level security, tested at the database rather than through the API.
 *
 * The API tests prove the application scopes its queries correctly. These
 * prove that it would not matter if it did not — that a query with the wrong
 * tenant context, or none, returns nothing regardless of what the application
 * asked for. That is the guarantee the whole tenancy model rests on.
 *
 * Every query here runs as the unprivileged application role. The owner
 * bypasses RLS unconditionally, so running these as the owner would pass
 * against completely broken policies — which is exactly how the first RLS
 * migration shipped looking correct while enforcing nothing.
 */
describe('row-level security', () => {
  let ctx: TestContext;
  let sql: postgres.Sql;
  let closeSql: () => Promise<void>;

  let hospitalA: string;
  let hospitalB: string;
  let patientA: string;
  let patientB: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Isolation Hospital A', mrnPrefix: 'ISA' });
    const b = await seedHospital({
      name: 'Isolation Hospital B',
      mrnPrefix: 'ISB',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;

    // Registered through the API, so the rows are created exactly as the
    // application creates them.
    const tokenA = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    const tokenB = await signIn(ctx, b.staff.frontDesk as SeededStaff);

    const createdA = await ctx
      .http()
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Anita Isolation', gender: 'female', dateOfBirth: '1979-04-11' });

    const createdB = await ctx
      .http()
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Bhaskar Isolation', gender: 'male', dateOfBirth: '1966-09-23' });

    patientA = createdA.body.patient.id;
    patientB = createdB.body.patient.id;

    const connection = appRoleDb();
    sql = connection.client;
    closeSql = connection.close;
  });

  afterAll(async () => {
    await closeSql?.();
    await ctx?.close();
  });

  /** Runs a query inside a transaction carrying the given tenant context. */
  async function asTenant<T>(hospitalId: string | null, query: string): Promise<T[]> {
    return sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_hospital_id', ${hospitalId ?? ''}, true)`;
      return tx.unsafe(query);
    }) as Promise<T[]>;
  }

  it('confirms the test connection is not a superuser', async () => {
    // If this fails, every other assertion in the file is meaningless.
    const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean; name: string }[]>`
      SELECT rolname AS name, rolsuper, rolbypassrls
        FROM pg_roles WHERE rolname = current_user
    `;

    expect(role?.rolsuper, 'tests must not run as a superuser').toBe(false);
    expect(role?.rolbypassrls, 'tests must not run with BYPASSRLS').toBe(false);
  });

  it('shows a hospital only its own patients', async () => {
    const seenByA = await asTenant<{ id: string }>(hospitalA, 'SELECT id FROM patient');
    const seenByB = await asTenant<{ id: string }>(hospitalB, 'SELECT id FROM patient');

    expect(seenByA.map((row) => row.id)).toEqual([patientA]);
    expect(seenByB.map((row) => row.id)).toEqual([patientB]);
  });

  it('returns nothing at all with no tenant context', async () => {
    // The important failure mode. A forgotten WHERE clause leaks silently; a
    // forgotten tenant context returns an empty set, which is loud and safe.
    const rows = await asTenant<{ id: string }>(null, 'SELECT id FROM patient');
    expect(rows).toEqual([]);
  });

  it('cannot reach another tenant even when naming the row directly', async () => {
    const rows = await asTenant<{ id: string }>(
      hospitalA,
      `SELECT id FROM patient WHERE id = '${patientB}'`,
    );

    expect(rows, 'knowing an id must not be enough to read it').toEqual([]);
  });

  it('scopes the link table, staff and hospitals the same way', async () => {
    const links = await asTenant<{ count: string }>(
      hospitalA,
      'SELECT count(*) AS count FROM patient_hospital_link',
    );
    expect(Number(links[0]?.count)).toBe(1);

    const staff = await asTenant<{ email: string }>(hospitalA, 'SELECT email FROM staff_user');
    expect(staff.every((row) => row.email.endsWith('.isa@example.in'))).toBe(true);

    const hospitals = await asTenant<{ id: string }>(hospitalA, 'SELECT id FROM hospital');
    expect(hospitals.map((row) => row.id)).toEqual([hospitalA]);
  });

  it('refuses to write a patient into another tenant', async () => {
    await expect(
      asTenant(
        hospitalA,
        `INSERT INTO patient (name, name_normalized, gender, created_by_hospital_id)
         VALUES ('Smuggled Record', 'smuggled record', 'male', '${hospitalB}')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to link another tenant to a patient', async () => {
    await expect(
      asTenant(
        hospitalA,
        `INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
         VALUES ('${patientA}', '${hospitalB}', 'SMUGGLED-1')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('keeps the audit log append-only even for the application role', async () => {
    await expect(
      asTenant(hospitalA, "UPDATE access_log SET action = 'read' WHERE true"),
    ).rejects.toThrow(/permission denied|append-only/i);

    await expect(asTenant(hospitalA, 'DELETE FROM access_log WHERE true')).rejects.toThrow(
      /permission denied|append-only/i,
    );
  });

  it('does not let the application read its own migration history', async () => {
    await expect(asTenant(hospitalA, 'SELECT * FROM drizzle.__drizzle_migrations')).rejects.toThrow(
      /permission denied/i,
    );
  });
});
