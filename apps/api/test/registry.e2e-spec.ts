import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * The patient registry, end to end.
 *
 * This covers the journey the product exists for: a person treated at an
 * Ayurvedic hospital walks into an allopathic one, and their record follows
 * them — without either hospital losing its own medical record number, and
 * without a hospital being able to reach a patient it has never seen.
 */
describe('patient registry', () => {
  let ctx: TestContext;
  let ayushToken: string;
  let cityToken: string;
  let ayushAdminToken: string;
  let clinicianToken: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const ayush = await seedHospital({ name: 'Registry Ayurvedic', mrnPrefix: 'RAY' });
    const city = await seedHospital({
      name: 'Registry General',
      mrnPrefix: 'RGN',
      facilityType: 'allopathic',
    });

    ayushToken = await signIn(ctx, ayush.staff.frontDesk as SeededStaff);
    cityToken = await signIn(ctx, city.staff.frontDesk as SeededStaff);
    ayushAdminToken = await signIn(ctx, ayush.staff.admin as SeededStaff);
    clinicianToken = await signIn(ctx, ayush.staff.clinician as SeededStaff);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const post = (path: string, token: string, body: unknown) =>
    ctx.http().post(path).set('Authorization', `Bearer ${token}`).send(body);

  const get = (path: string, token: string) =>
    ctx.http().get(path).set('Authorization', `Bearer ${token}`);

  it('registers a patient and issues a prefixed medical record number', async () => {
    const response = await post('/api/v1/patients', ayushToken, {
      name: 'Devika Registry',
      gender: 'female',
      dateOfBirth: '1988-07-19',
      phone: '9810000001',
    });

    expect(response.status).toBe(201);
    expect(response.body.linkedExisting).toBe(false);
    expect(response.body.patient.mrn).toMatch(/^RAY-\d{6}$/);
  });

  it('never issues the same number twice', async () => {
    const seen = new Set<string>();

    for (let i = 0; i < 5; i += 1) {
      const response = await post('/api/v1/patients', ayushToken, {
        name: `Sequential Patient ${'x'.repeat(i + 1)}`,
        gender: 'male',
        approximateAgeYears: 40 + i,
      });

      expect(response.status).toBe(201);
      seen.add(response.body.patient.mrn);
    }

    expect(seen.size, 'duplicate MRNs are a clinical safety incident').toBe(5);
  });

  it('links the same person at a second hospital instead of duplicating them', async () => {
    const first = await post('/api/v1/patients', ayushToken, {
      name: 'Harish Crossover',
      gender: 'male',
      dateOfBirth: '1975-11-02',
      phone: '9810000002',
    });

    const second = await post('/api/v1/patients', cityToken, {
      name: 'Harish Crossover',
      gender: 'male',
      dateOfBirth: '1975-11-02',
      phone: '9810000002',
    });

    expect(second.status).toBe(201);
    expect(second.body.linkedExisting, 'the whole product rests on this').toBe(true);
    expect(second.body.patient.id).toBe(first.body.patient.id);

    // Same person, different number at each hospital.
    expect(first.body.patient.mrn).toMatch(/^RAY-/);
    expect(second.body.patient.mrn).toMatch(/^RGN-/);
  });

  it('hides a patient from a hospital that has never seen them', async () => {
    const created = await post('/api/v1/patients', ayushToken, {
      name: 'Private Person',
      gender: 'female',
      dateOfBirth: '1993-03-03',
      phone: '9810000003',
    });

    const id = created.body.patient.id;

    const direct = await get(`/api/v1/patients/${id}`, cityToken);
    expect(direct.status, 'not found reveals less than forbidden').toBe(404);

    const search = await get('/api/v1/patients?q=Private', cityToken);
    expect(search.body.results).toEqual([]);
  });

  it('refuses to link a patient the caller cannot identify', async () => {
    const created = await post('/api/v1/patients', ayushToken, {
      name: 'Unguessable Person',
      gender: 'male',
      dateOfBirth: '1960-01-01',
      phone: '9810000004',
    });

    // Knowing an id must never be enough — linking grants access to the record.
    const attempt = await post(`/api/v1/patients/${created.body.patient.id}/link`, cityToken, {
      name: 'Completely Different Name',
      gender: 'female',
    });

    expect(attempt.status).toBe(404);
  });

  it('refuses an uncertain match rather than guessing, and masks the candidates', async () => {
    await post('/api/v1/patients', ayushToken, {
      name: 'Ambiguous Person',
      gender: 'male',
      dateOfBirth: '1982-05-05',
      phone: '9810000005',
    });

    const similar = await post('/api/v1/patients', ayushToken, {
      name: 'Ambiguous Person',
      gender: 'male',
      dateOfBirth: '1982-05-05',
      phone: '9820000005', // different handset
    });

    expect(similar.status).toBe(409);
    expect(similar.body.code).toBe('POSSIBLE_DUPLICATE');
    expect(similar.body.candidates.length).toBeGreaterThan(0);
    expect(similar.body.candidates[0].maskedName).toContain('•');
    expect(
      JSON.stringify(similar.body.candidates),
      'an unmasked name must not cross between hospitals',
    ).not.toContain('Ambiguous');
  });

  it('queues an overridden duplicate for review rather than losing it', async () => {
    const forced = await post('/api/v1/patients', ayushToken, {
      name: 'Ambiguous Person',
      gender: 'male',
      dateOfBirth: '1982-05-05',
      phone: '9820000005',
      forceCreate: true,
    });

    expect(forced.status).toBe(201);
    expect(forced.body.queuedForReview).toBeGreaterThan(0);

    const queue = await get('/api/v1/patients/merge-queue', ayushAdminToken);
    expect(queue.status).toBe(200);
    expect(queue.body.length).toBeGreaterThan(0);
    expect(queue.body[0].patients[0].maskedName).toContain('•');
  });

  it('merges a confirmed duplicate and can undo it', async () => {
    const queue = await get('/api/v1/patients/merge-queue', ayushAdminToken);
    const pairing = queue.body[0];
    const survivor = pairing.patients[0].patientId;
    const merged = pairing.patients[1].patientId;

    const resolve = await post(
      `/api/v1/patients/merge-queue/${pairing.id}/resolve`,
      ayushAdminToken,
      { decision: 'merge', reason: 'confirmed duplicate', keepPatientId: survivor },
    );

    expect(resolve.status).toBe(201);
    expect(resolve.body.survivingPatientId).toBe(survivor);
    expect(typeof resolve.body.mergeLogId, 'reversibility must be reachable').toBe('string');

    expect((await get(`/api/v1/patients/${merged}`, ayushToken)).status).toBe(404);
    expect((await get(`/api/v1/patients/${survivor}`, ayushToken)).status).toBe(200);

    // Clinical rows recorded against the merged record must follow the
    // survivor for consent and the timeline, and stop following it on revert.
    const aliasesFor = async () => {
      const { client, close } = testDb();
      try {
        return await client<Array<{ survivor: string }>>`
          SELECT surviving_patient_id AS survivor
            FROM patient_merge_alias WHERE merged_patient_id = ${merged}
        `;
      } finally {
        await close();
      }
    };

    expect(await aliasesFor()).toEqual([{ survivor }]);

    const revert = await post(
      `/api/v1/patients/merges/${resolve.body.mergeLogId}/revert`,
      ayushAdminToken,
      { reason: 'merged in error' },
    );

    expect(revert.status).toBe(201);
    expect(revert.body.restoredPatientId).toBe(merged);
    expect(await aliasesFor(), 'a reverted merge must not keep resolving').toEqual([]);
    expect((await get(`/api/v1/patients/${merged}`, ayushToken)).status).toBe(200);
    expect((await get(`/api/v1/patients/${survivor}`, ayushToken)).status).toBe(200);
  });

  it('requires a reason for a demographic correction', async () => {
    const created = await post('/api/v1/patients', ayushToken, {
      name: 'Correctable Person',
      gender: 'female',
      approximateAgeYears: 55,
    });

    const id = created.body.patient.id;

    const withoutReason = await ctx
      .http()
      .patch(`/api/v1/patients/${id}`)
      .set('Authorization', `Bearer ${clinicianToken}`)
      .send({ bloodGroup: 'A+' });

    expect(withoutReason.status).toBe(400);

    const withReason = await ctx
      .http()
      .patch(`/api/v1/patients/${id}`)
      .set('Authorization', `Bearer ${clinicianToken}`)
      .send({ bloodGroup: 'A+', reason: 'confirmed against lab report' });

    expect(withReason.status).toBe(200);
    expect(withReason.body.bloodGroup).toBe('A+');
  });

  it('accepts an age when the patient does not know their date of birth', async () => {
    // Extremely common, and a registration that cannot proceed without a date
    // of birth is a registration that gets faked.
    const response = await post('/api/v1/patients', ayushToken, {
      name: 'Approximate Age Person',
      gender: 'undisclosed',
      approximateAgeYears: 67,
    });

    expect(response.status).toBe(201);
    expect(response.body.patient.approximateAgeYears).toBe(67);
    expect(response.body.patient.dateOfBirth).toBeNull();
  });
});
