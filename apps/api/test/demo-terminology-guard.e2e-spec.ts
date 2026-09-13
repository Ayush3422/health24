import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  loadDemoTerminology,
  resetDatabase,
  seedHospital,
  signIn,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * The application as production runs it, with demo terminology refused.
 *
 * A separate file because configuration is read once, when the application
 * module loads; vitest gives each spec file its own module graph, so setting
 * the variable before booting takes effect here without touching other suites.
 */
describe('demo terminology on a patient record', () => {
  let ctx: TestContext;
  const previous = process.env.ALLOW_DEMO_TERMINOLOGY;

  beforeAll(async () => {
    process.env.ALLOW_DEMO_TERMINOLOGY = 'false';

    await resetDatabase();
    await loadDemoTerminology();
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx?.close();

    if (previous === undefined) delete process.env.ALLOW_DEMO_TERMINOLOGY;
    else process.env.ALLOW_DEMO_TERMINOLOGY = previous;
  });

  it('is refused, and nothing is written', async () => {
    const hospital = await seedHospital({ name: 'Guard Test Hospital', mrnPrefix: 'GTH' });
    const clinician = await signIn(ctx, hospital.staff.clinician as SeededStaff);
    const auth = { Authorization: `Bearer ${clinician}` };

    const patient = await ctx
      .http()
      .post('/api/v1/patients')
      .set(auth)
      .send({ name: 'Guarded Patient', gender: 'male', approximateAgeYears: 40 });

    const encounter = await ctx
      .http()
      .post('/api/v1/encounters')
      .set(auth)
      .send({ patientId: patient.body.patient.id });

    const response = await ctx
      .http()
      .post('/api/v1/diagnoses')
      .set(auth)
      .send({ encounterId: encounter.body.id, code: 'DEMO-NAM-001' });

    expect(response.status).toBe(422);

    const listed = await ctx
      .http()
      .get(`/api/v1/encounters/${encounter.body.id}/diagnoses`)
      .set(auth);

    expect(listed.body).toEqual([]);
  });
});
