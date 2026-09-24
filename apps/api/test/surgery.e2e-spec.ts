import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appRoleDb,
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  type SeededStaff,
  type TestContext,
} from './harness';

type Procedure = {
  id: string;
  name: string;
  preOpAssessment: string | null;
  anaesthesia: string | null;
  operativeNote: string | null;
  postOpCourse: string | null;
  supersedesId: string | null;
};

type Implant = {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialOrLot: string | null;
  implantedAt: string;
  procedureId: string | null;
  procedureName: string | null;
  notes: string | null;
};

/**
 * The surgery record (sp6-plan.md, Phase 4, Decision Q1): what was assessed
 * beforehand, what was done, what was put in, and how the patient did after.
 */
describe('the operative record and its devices', () => {
  let ctx: TestContext;

  let hospitalId: string;
  let clinicianToken: string;
  let recordsToken: string;
  let deskToken: string;
  let otherClinicianToken: string;
  let clinician: SeededStaff;

  let patientId: string;
  let encounterId: string;
  let procedureId: string;

  const post = (path: string, bearer: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`).send(body);

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Surgery Test', mrnPrefix: 'SST' });
    const b = await seedHospital({
      name: 'City General Surgery Test',
      mrnPrefix: 'CGS',
      facilityType: 'allopathic',
    });

    hospitalId = a.hospital.id;
    clinician = a.staff.clinician as SeededStaff;
    clinicianToken = await signIn(ctx, clinician);
    recordsToken = await signIn(ctx, a.staff.records as SeededStaff);
    deskToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    otherClinicianToken = await signIn(ctx, b.staff.clinician as SeededStaff);

    patientId = (
      await post('/patients', deskToken, {
        name: 'Operated Patient',
        gender: 'male',
        dateOfBirth: '1966-03-08',
        phone: '9820088001',
      })
    ).body.patient.id;

    encounterId = (await post('/encounters', clinicianToken, { patientId, class: 'inpatient' }))
      .body.id;
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('records the operation: what was assessed, done, and how the patient did after', async () => {
    const recorded = await post('/procedures', clinicianToken, {
      encounterId,
      name: 'Total hip replacement, right',
      performedAt: new Date(Date.now() - 7_200_000).toISOString(),
      preOpAssessment: 'Fit for surgery. Hb 12.4, no cardiac history. Consent taken.',
      anaesthesia: 'Spinal, with sedation',
      operativeNote:
        'Posterior approach. Acetabulum reamed to 52 mm. Uncemented cup and stem. Haemostasis secured.',
      postOpCourse: 'Mobilised with a frame on day one. Wound clean.',
      outcome: 'Uncomplicated',
    });

    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    const procedure = recorded.body as Procedure;
    procedureId = procedure.id;

    expect(procedure).toMatchObject({
      name: 'Total hip replacement, right',
      anaesthesia: 'Spinal, with sedation',
      preOpAssessment: expect.stringContaining('Fit for surgery'),
      operativeNote: expect.stringContaining('Posterior approach'),
      postOpCourse: expect.stringContaining('Mobilised'),
    });

    // A therapy session leaves them empty, and is none the worse for it.
    const therapy = await post('/procedures', clinicianToken, {
      encounterId,
      name: 'Shirodhara',
      systemOfMedicine: 'ayurveda',
    });
    expect(therapy.status).toBe(201);
    expect(therapy.body).toMatchObject({ operativeNote: null, anaesthesia: null });
  });

  it('records what was implanted, with the operation it came from', async () => {
    const implanted = await post('/implants', clinicianToken, {
      encounterId,
      procedureId,
      name: 'Uncemented acetabular cup',
      manufacturer: 'Meditech Implants',
      model: 'MT-52',
      serialOrLot: 'LOT-2026-0041',
      notes: 'Right hip, 52 mm',
    });

    expect(implanted.status, JSON.stringify(implanted.body)).toBe(201);
    const implant = implanted.body as Implant;

    expect(implant).toMatchObject({
      name: 'Uncemented acetabular cup',
      serialOrLot: 'LOT-2026-0041',
      procedureId,
      procedureName: 'Total hip replacement, right',
    });

    // The time defaults to the operation's own, not to when it was typed.
    const procedure = (
      await get(`/encounters/${encounterId}/procedures`, clinicianToken)
    ).body.find((row: Procedure) => row.id === procedureId);
    expect(implant.implantedAt).toBe((procedure as { performedAt: string }).performedAt);

    const stem = await post('/implants', recordsToken, {
      encounterId,
      procedureId,
      name: 'Femoral stem',
      manufacturer: 'Meditech Implants',
      serialOrLot: 'SN-778-9921',
      onBehalfOfClinicianId: clinician.id,
    });
    expect(stem.status, JSON.stringify(stem.body)).toBe(201);
    expect(stem.body).toMatchObject({ entry: { source: 'transcribed' } });

    const onEncounter = await get(`/encounters/${encounterId}/implants`, clinicianToken);
    expect(onEncounter.body).toHaveLength(2);
  });

  it('refuses a device against another patient’s operation', async () => {
    const otherPatient = (
      await post('/patients', deskToken, {
        name: 'Another Patient',
        gender: 'female',
        dateOfBirth: '1990-09-09',
        phone: '9820088002',
      })
    ).body.patient.id;

    const otherEncounter = (
      await post('/encounters', clinicianToken, { patientId: otherPatient, class: 'inpatient' })
    ).body.id;

    const wrong = await post('/implants', clinicianToken, {
      encounterId: otherEncounter,
      procedureId,
      name: 'Femoral stem',
    });

    expect(wrong.status, JSON.stringify(wrong.body)).toBe(400);
  });

  it('finds a batch by its lot, for a recall, and names who carries one', async () => {
    const found = await get('/implants?q=LOT-2026', clinicianToken);
    expect(found.status, JSON.stringify(found.body)).toBe(200);

    expect(found.body.results).toEqual([
      expect.objectContaining({
        serialOrLot: 'LOT-2026-0041',
        patient: expect.objectContaining({ name: 'Operated Patient' }),
      }),
    ]);

    // By model as well, because a recall notice often names only that.
    expect((await get('/implants?q=MT-52', clinicianToken)).body.results).toHaveLength(1);

    // Another hospital's search finds nothing of ours: a recall is answered by
    // each hospital for its own patients.
    expect((await get('/implants?q=LOT-2026', otherClinicianToken)).body.results).toEqual([]);
  });

  it('is corrected by superseding, and the old serial stays findable in the history', async () => {
    const [device] = (await get(`/encounters/${encounterId}/implants`, clinicianToken)).body;

    const corrected = await post(`/implants/${device.id}/correct`, clinicianToken, {
      name: 'Uncemented acetabular cup',
      manufacturer: 'Meditech Implants',
      model: 'MT-52',
      serialOrLot: 'LOT-2026-0042',
      notes: 'Right hip, 52 mm',
      procedureId,
      reason: 'Lot number typed from the wrong sticker',
    });

    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect(corrected.body).toMatchObject({
      serialOrLot: 'LOT-2026-0042',
      supersedesId: device.id,
    });

    // The current record shows the new lot only.
    const now = (await get('/implants?q=LOT-2026-0041', clinicianToken)).body.results;
    expect(now).toEqual([]);

    // The history still holds both, which is what a recall audit needs.
    const history = await get(`/clinical-history/implants/${device.id}`, clinicianToken);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body).toHaveLength(2);
    expect(history.body[0].label).toContain('LOT-2026-0041');
    expect(history.body[1].label).toContain('LOT-2026-0042');
  });

  it('is never edited or deleted in the database', async () => {
    const [device] = (await get(`/encounters/${encounterId}/implants`, clinicianToken)).body;
    const { client: app, close } = appRoleDb();

    try {
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`UPDATE implant_device SET serial_or_lot = 'RUBBED-OUT' WHERE id = ${device.id}`;
        }),
      ).rejects.toThrow(/permission denied|immutable/);

      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`DELETE FROM implant_device WHERE id = ${device.id}`;
        }),
      ).rejects.toThrow(/permission denied|never deleted/);
    } finally {
      await close();
    }
  });

  it('travels to another hospital only under a consent that covers procedures', async () => {
    const before = await get(`/patients/${patientId}/implants`, otherClinicianToken);
    // Not registered there yet, so not even a patient they can ask about.
    expect([403, 404]).toContain(before.status);
  });
});
