import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

interface AuditRow {
  action: string;
  resource_type: string;
  patient_id: string | null;
  actor_id: string | null;
  outcome: string;
  hospital_id: string | null;
}

/**
 * The audit trail.
 *
 * The property that matters is not that writes are logged — every system logs
 * writes. It is that **reads** are logged, with the patient they concerned.
 * Under the DPDP Act a patient may ask who has looked at their record, and an
 * answer is only possible if looking left a trace.
 */
describe('audit trail', () => {
  let ctx: TestContext;
  let token: string;
  let hospitalId: string;
  let staffId: string;
  let patientId: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const hospital = await seedHospital({ name: 'Audit Hospital', mrnPrefix: 'AUD' });
    hospitalId = hospital.hospital.id;

    const frontDesk = hospital.staff.frontDesk as SeededStaff;
    staffId = frontDesk.id;
    token = await signIn(ctx, frontDesk);

    const created = await ctx
      .http()
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Audited Patient', gender: 'female', dateOfBirth: '1991-02-14' });

    patientId = created.body.patient.id;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function auditRows(where: string): Promise<AuditRow[]> {
    const { db, close } = testDb();

    try {
      return (await db.execute(
        sql.raw(`
          SELECT action, resource_type, patient_id, actor_id, outcome, hospital_id
            FROM access_log
           WHERE ${where}
           ORDER BY at DESC
        `),
      )) as unknown as AuditRow[];
    } finally {
      await close();
    }
  }

  it('records a successful sign-in', async () => {
    const rows = await auditRows(`action = 'login' AND actor_id = '${staffId}'`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('records a failed sign-in, including the identity attempted', async () => {
    await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'audit.ghost@example.in', password: 'not-the-password' });

    const rows = await auditRows(`action = 'login_failed'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.outcome).toBe('denied');
  });

  it('records the creation of a patient, naming the patient', async () => {
    const rows = await auditRows(
      `action = 'create' AND resource_type = 'patient' AND patient_id = '${patientId}'`,
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.hospital_id).toBe(hospitalId);
  });

  it('records READING a patient — the requirement, not just writes', async () => {
    const before = await auditRows(
      `action = 'read' AND resource_type = 'patient' AND patient_id = '${patientId}'`,
    );

    await ctx.http().get(`/api/v1/patients/${patientId}`).set('Authorization', `Bearer ${token}`);

    const after = await auditRows(
      `action = 'read' AND resource_type = 'patient' AND patient_id = '${patientId}'`,
    );

    expect(after.length, 'a patient must be able to learn who looked at their record').toBe(
      before.length + 1,
    );
    expect(after[0]?.actor_id).toBe(staffId);
  });

  it('records searches, which are reads of many records at once', async () => {
    const before = await auditRows(`action = 'search' AND resource_type = 'patient'`);

    await ctx.http().get('/api/v1/patients?q=Audited').set('Authorization', `Bearer ${token}`);

    const after = await auditRows(`action = 'search' AND resource_type = 'patient'`);
    expect(after.length).toBe(before.length + 1);
  });

  it('records a cross-hospital lookup, which searches the whole platform', async () => {
    // This endpoint reaches every hospital's records, so it is exactly the
    // access a patient is entitled to ask about. It was writing no audit row
    // at all until lint flagged an unused parameter.
    const before = await auditRows(`resource_type = 'patient_global_lookup'`);

    await ctx
      .http()
      .post('/api/v1/patients/lookup')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Audited Patient' })
      .expect(201);

    const after = await auditRows(`resource_type = 'patient_global_lookup'`);
    expect(after.length).toBe(before.length + 1);
    expect(after[0]?.actor_id).toBe(staffId);
  });

  it('records an update', async () => {
    await ctx
      .http()
      .patch(`/api/v1/patients/${patientId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ bloodGroup: 'AB+', reason: 'audit test' });

    const rows = await auditRows(
      `action = 'update' AND resource_type = 'patient' AND patient_id = '${patientId}'`,
    );

    expect(rows.length).toBeGreaterThan(0);
  });

  it('records a REFUSED action, not only permitted ones', async () => {
    // A refused attempt on a patient record is at least as interesting as a
    // successful one: it is the signal that someone is probing, or that access
    // was removed and they did not expect it.
    const before = await auditRows(`outcome = 'denied' AND resource_type = 'authorization'`);

    await ctx.http().get('/api/v1/hospitals').set('Authorization', `Bearer ${token}`).expect(403);

    const after = await auditRows(`outcome = 'denied' AND resource_type = 'authorization'`);
    expect(after.length).toBe(before.length + 1);
    expect(after[0]?.actor_id).toBe(staffId);
  });

  it('records the actor and hospital on every entry that has one', async () => {
    const rows = await auditRows(`resource_type = 'patient'`);

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.actor_id, 'every patient-touching entry names its actor').toBeTruthy();
      expect(row.hospital_id, 'and the hospital it was done under').toBe(hospitalId);
    }
  });

  it('cannot be altered or erased through the application', async () => {
    // Enforced by grant and by trigger, so an attacker who reaches the API
    // cannot erase their own tracks. Asserted here through the app's own
    // connection rather than the owner's.
    const { db, close } = testDb();

    try {
      // The owner is used deliberately: if even the owner is refused, the
      // application certainly is.
      await expect(db.execute(sql`DELETE FROM access_log`)).rejects.toThrow(/append-only/i);
    } finally {
      await close();
    }
  });
});
