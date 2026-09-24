import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { bedDaysOf } from '../src/modules/wards/admissions.service';
import {
  appRoleDb,
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

type Bed = { id: string; label: string; status: string; occupant: { name: string } | null };
type Ward = { id: string; name: string; beds: Bed[]; occupied: number; free: number };
type Admission = {
  encounterId: string;
  patientId: string;
  patientName: string;
  currentBed: Bed | null;
  dischargedAt: string | null;
  bedDays: number;
  stays: Array<{ bed: string; ward: string; endedAt: string | null; movedReason: string | null }>;
};

/**
 * Wards, beds and the stay in one (sp6-plan.md, Phase 3, Decision P1): a
 * patient is admitted to a named bed, moved once, and discharged — and the
 * history reads the same afterwards as the board did at the time.
 */
describe('admission, ward and bed', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalId: string;
  let otherHospitalId: string;
  let adminToken: string;
  let deskToken: string;
  let clinicianToken: string;
  let otherAdminToken: string;

  let patientId: string;
  let secondPatientId: string;
  let ward: Ward;
  let dayCare: Ward;

  const post = (path: string, bearer: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`).send(body);

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  const bedNamed = (of: Ward, label: string): string =>
    of.beds.find((bed) => bed.label === label)!.id;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Ward Test', mrnPrefix: 'SWT' });
    const b = await seedHospital({
      name: 'City General Ward Test',
      mrnPrefix: 'CGW',
      facilityType: 'allopathic',
    });

    hospitalId = a.hospital.id;
    otherHospitalId = b.hospital.id;

    adminToken = await signIn(ctx, a.staff.admin as SeededStaff);
    deskToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    clinicianToken = await signIn(ctx, a.staff.clinician as SeededStaff);
    otherAdminToken = await signIn(ctx, b.staff.admin as SeededStaff);

    patientId = (
      await post('/patients', deskToken, {
        name: 'Admitted Patient',
        gender: 'female',
        dateOfBirth: '1980-07-09',
        phone: '9820077001',
      })
    ).body.patient.id;

    secondPatientId = (
      await post('/patients', deskToken, {
        name: 'Second Patient',
        gender: 'male',
        dateOfBirth: '1972-01-15',
        phone: '9820077002',
      })
    ).body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  }, 120_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('is set up by the hospital administrator, with its beds', async () => {
    const created = await post('/wards', adminToken, {
      name: 'General ward',
      kind: 'general',
      beds: ['G1', 'G2', 'G3'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    ward = created.body as Ward;

    expect(ward).toMatchObject({ name: 'General ward', occupied: 0, free: 3 });
    expect(ward.beds.map((bed) => bed.label)).toEqual(['G1', 'G2', 'G3']);

    const second = await post('/wards', adminToken, {
      name: 'Day care',
      kind: 'day_care',
      beds: ['D1'],
    });
    dayCare = second.body as Ward;

    // Two wards cannot share a name, and one ward cannot have two G1s.
    expect((await post('/wards', adminToken, { name: 'General ward', kind: 'icu' })).status).toBe(
      400,
    );
    expect((await post(`/wards/${ward.id}/beds`, adminToken, { labels: ['G1'] })).status).toBe(400);

    // And the desk does not rearrange the furniture.
    expect((await post('/wards', deskToken, { name: 'Ward X', kind: 'general' })).status).toBe(403);
  });

  it('a bed belongs to an inpatient encounter, which the clinician opens', async () => {
    // An outpatient consultation puts nobody to bed.
    const outpatient = (await post('/encounters', clinicianToken, { patientId })).body.id;
    const refused = await post('/admissions', deskToken, {
      encounterId: outpatient,
      bedId: bedNamed(ward, 'G2'),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
  });

  it('admits a patient to a named bed, and shows them on the board', async () => {
    // The clinician decides to admit; the desk gives the bed.
    const encounterId = (
      await post('/encounters', clinicianToken, {
        patientId,
        class: 'inpatient',
        chiefComplaint: 'Severe dehydration; needs fluids and observation',
      })
    ).body.id;

    const admitted = await post('/admissions', deskToken, {
      encounterId,
      bedId: bedNamed(ward, 'G1'),
    });
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(201);

    const admission = admitted.body as Admission;
    expect(admission).toMatchObject({
      patientId,
      patientName: 'Admitted Patient',
      dischargedAt: null,
      bedDays: 1,
      currentBed: { label: 'G1' },
    });

    const board = await get('/wards', deskToken);
    const general = (board.body.wards as Ward[]).find((row) => row.id === ward.id)!;
    expect(general).toMatchObject({ occupied: 1, free: 2 });
    expect(general.beds.find((bed) => bed.label === 'G1')!.occupant).toMatchObject({
      name: 'Admitted Patient',
    });

    // The admission is an inpatient encounter, not a new kind of thing.
    const encounter = await get(`/encounters/${admission.encounterId}`, clinicianToken);
    expect(encounter.body).toMatchObject({ class: 'inpatient', status: 'in_progress' });
  });

  it('refuses a second patient in the same bed, a blocked bed and a closed ward', async () => {
    const secondEncounter = (
      await post('/encounters', clinicianToken, { patientId: secondPatientId, class: 'inpatient' })
    ).body.id;

    const taken = await post('/admissions', deskToken, {
      encounterId: secondEncounter,
      bedId: bedNamed(ward, 'G1'),
    });
    expect(taken.status, JSON.stringify(taken.body)).toBe(409);

    const blocked = await post(`/beds/${bedNamed(ward, 'G3')}/status`, adminToken, {
      status: 'blocked',
      reason: 'Mattress being replaced',
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    expect(blocked.body).toMatchObject({
      status: 'blocked',
      blockedReason: 'Mattress being replaced',
    });

    const outOfService = await post('/admissions', deskToken, {
      encounterId: secondEncounter,
      bedId: bedNamed(ward, 'G3'),
    });
    expect(outOfService.status, JSON.stringify(outOfService.body)).toBe(409);

    // A ward with a patient in it cannot be closed.
    expect((await post(`/wards/${ward.id}`, adminToken, { status: 'closed' })).status).toBe(409);

    // An empty one can, and then admits nobody.
    expect((await post(`/wards/${dayCare.id}`, adminToken, { status: 'closed' })).status).toBe(200);
    expect(
      (
        await post('/admissions', deskToken, {
          encounterId: secondEncounter,
          bedId: bedNamed(dayCare, 'D1'),
        })
      ).status,
    ).toBe(409);

    await post(`/wards/${dayCare.id}`, adminToken, { status: 'active' });
  });

  it('a bed with somebody in it cannot be taken out of service', async () => {
    const refused = await post(`/beds/${bedNamed(ward, 'G1')}/status`, adminToken, {
      status: 'blocked',
      reason: 'Repairs',
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  });

  it('moves the patient: one stay ends, the next begins, and the board follows', async () => {
    const [current] = (await get('/admissions', deskToken)).body.admissions as Admission[];

    const moved = await post(`/admissions/${current!.encounterId}/transfer`, deskToken, {
      bedId: bedNamed(ward, 'G2'),
      reason: 'Moved nearer the nurses’ station overnight',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const admission = moved.body as Admission;
    expect(admission.currentBed).toMatchObject({ label: 'G2' });
    expect(admission.stays).toHaveLength(2);
    expect(admission.stays[0]).toMatchObject({
      bed: 'G1',
      movedReason: 'Moved nearer the nurses’ station overnight',
    });
    expect(admission.stays[0]!.endedAt).toBeTruthy();
    expect(admission.stays[1]).toMatchObject({ bed: 'G2', endedAt: null });

    // G1 is free again; the same bed is not held by a stay that has ended.
    const board = await get('/wards', deskToken);
    const general = (board.body.wards as Ward[]).find((row) => row.id === ward.id)!;
    expect(general.beds.find((bed) => bed.label === 'G1')!.occupant).toBeNull();
    expect(general.beds.find((bed) => bed.label === 'G2')!.occupant).toMatchObject({
      name: 'Admitted Patient',
    });

    // The freed bed takes the next patient.
    const nextEncounter = (
      await post('/encounters', clinicianToken, { patientId: secondPatientId, class: 'inpatient' })
    ).body.id;

    const next = await post('/admissions', deskToken, {
      encounterId: nextEncounter,
      bedId: bedNamed(ward, 'G1'),
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
  });

  it('discharges: the bed is freed and the encounter finishes together', async () => {
    const admissions = (await get('/admissions', deskToken)).body.admissions as Admission[];
    const hers = admissions.find((row) => row.patientId === patientId)!;

    const discharged = await post(`/admissions/${hers.encounterId}/discharge`, deskToken, {
      note: 'Discharged home, improving',
    });
    expect(discharged.status, JSON.stringify(discharged.body)).toBe(200);
    expect(discharged.body).toMatchObject({ currentBed: null });
    expect(discharged.body.dischargedAt).toBeTruthy();

    const encounter = await get(`/encounters/${hers.encounterId}`, clinicianToken);
    expect(encounter.body).toMatchObject({ status: 'finished' });

    // Gone from the current list, still there in the whole history.
    const current = (await get('/admissions', deskToken)).body.admissions as Admission[];
    expect(current.some((row) => row.patientId === patientId)).toBe(false);

    const all = (await get('/admissions?scope=all', deskToken)).body.admissions as Admission[];
    const closed = all.find((row) => row.patientId === patientId)!;
    expect(closed.stays.every((stay) => stay.endedAt !== null)).toBe(true);
    expect(closed.bedDays).toBeGreaterThanOrEqual(1);

    // Discharging twice says so rather than pretending.
    expect((await post(`/admissions/${hers.encounterId}/discharge`, deskToken, {})).status).toBe(
      404,
    );
  });

  it('counts a started day as a bed-day, as a hospital bills it', () => {
    const day = (date: string) => `${date}T09:00:00+05:30`;

    expect(bedDaysOf(day('2026-09-20'), day('2026-09-20'))).toBe(1);
    expect(bedDaysOf(day('2026-09-20'), day('2026-09-21'))).toBe(2);
    expect(bedDaysOf(day('2026-09-20'), day('2026-09-25'))).toBe(6);
    // Just before midnight to just after is two days, because two days were used.
    expect(bedDaysOf('2026-09-20T18:20:00Z', '2026-09-20T19:00:00Z')).toBe(2);
  });

  it('is the hospital’s own: another hospital sees no ward, bed or stay of it', async () => {
    const theirs = await get('/wards', otherAdminToken);
    expect(theirs.status).toBe(200);
    expect(theirs.body.wards).toEqual([]);

    const { client: app, close } = appRoleDb();
    try {
      const counts = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${otherHospitalId}, true)`;
        return tx`
          SELECT (SELECT count(*)::int FROM ward) AS wards,
                 (SELECT count(*)::int FROM bed) AS beds,
                 (SELECT count(*)::int FROM bed_stay) AS stays
        `;
      });

      expect(counts[0]).toMatchObject({ wards: 0, beds: 0, stays: 0 });
    } finally {
      await close();
    }
  });

  it('in the database, refuses a second open stay, a deletion and a rewrite', async () => {
    const [stay] = await owner<
      Array<{ id: string; bed_id: string; encounter_id: string; patient_id: string }>
    >`
      SELECT id, bed_id, encounter_id, patient_id FROM bed_stay WHERE ended_at IS NULL LIMIT 1
    `;

    const { client: app, close } = appRoleDb();

    try {
      // Two patients in one bed, or one patient in two: both refused by an index.
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`
            INSERT INTO bed_stay (hospital_id, encounter_id, patient_id, bed_id, started_by_staff_id)
            SELECT hospital_id, encounter_id, patient_id, bed_id, started_by_staff_id
              FROM bed_stay WHERE id = ${stay!.id}
          `;
        }),
      ).rejects.toThrow(/bed_stay_one_open_per/);

      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`DELETE FROM bed_stay WHERE id = ${stay!.id}`;
        }),
      ).rejects.toThrow(/permission denied|never deleted/);

      // Where somebody lay is not rewritten afterwards.
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`UPDATE bed_stay SET started_at = now() WHERE id = ${stay!.id}`;
        }),
      ).rejects.toThrow(/permission denied|immutable/);
    } finally {
      await close();
    }
  });
});
