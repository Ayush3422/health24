import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

type ResultSetBody = {
  id: string;
  hospital: { isOwn: boolean };
  results: Array<{
    code: string;
    value: number;
    unit: string;
    valueCanonical: number;
    interpretation: string | null;
  }>;
};

/**
 * Lab results end to end (SP4 Phase 4): typed from a report against a curated
 * panel, flagged against the lab's own range, converted to one unit, shared
 * under consent for observations, and drawn as a trend across hospitals.
 */
describe('lab results', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalA: string;
  let frontDeskA: SeededStaff;
  let adminA: SeededStaff;
  let clinicianB: SeededStaff;
  let clinicianToken: string;
  let frontDeskToken: string;
  let clinicianBToken: string;
  let frontDeskBToken: string;

  let patientId: string;
  let patientOnlyAtA: string;
  let reportA: string;
  let otherPatientsReport: string;

  let lftAtA: string;

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  const lftAtSanjeevani = () => ({
    patientId,
    panel: 'lft',
    collectedAt: '2026-09-01T09:30:00+05:30',
    documentId: reportA,
    performingFacility: 'Metro Diagnostics',
    results: [
      { code: '1742-6', value: 82, unit: 'U/L', referenceLow: 7, referenceHigh: 56 },
      { code: '1975-2', value: 17.1, unit: 'umol/L', referenceLow: 3.4, referenceHigh: 20.5 },
      { code: '1751-7', value: 3.2, unit: 'g/dL', referenceText: '3.5 - 5.0', labFlag: 'L' },
    ],
  });

  async function insertReport(forPatient: string): Promise<string> {
    const id = randomUUID();

    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      await tx`
        INSERT INTO document_reference
          (id, patient_id, hospital_id, doc_type, report_date, recorded_by_staff_id,
           availability, availability_changed_at, upload_confirmed_at)
        VALUES (${id}, ${forPatient}, ${hospitalA}, 'lab_report', '2026-09-01', ${frontDeskA.id},
                'available', now(), now())
      `;
    });

    return id;
  }

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Results Test', mrnPrefix: 'SRT' });
    const b = await seedHospital({
      name: 'City General Results Test',
      mrnPrefix: 'GRT',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital.id;
    frontDeskA = a.staff.frontDesk as SeededStaff;
    adminA = a.staff.admin as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;

    clinicianToken = await signIn(ctx, a.staff.clinician as SeededStaff);
    frontDeskToken = await signIn(ctx, frontDeskA);
    clinicianBToken = await signIn(ctx, clinicianB);
    frontDeskBToken = await signIn(ctx, b.staff.frontDesk as SeededStaff);

    const register = (name: string, phone: string) =>
      post('/patients', frontDeskToken, {
        name,
        gender: 'female',
        dateOfBirth: '1969-03-03',
        phone,
      });

    patientId = (await register('Kamala Results', '9820020201')).body.patient.id;
    patientOnlyAtA = (await register('Leela Elsewhere', '9820020202')).body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
        VALUES (${patientId}, ${b.hospital.id}, 'GRT-000001')
      `;
    });

    reportA = await insertReport(patientId);
    otherPatientsReport = await insertReport(patientOnlyAtA);
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  describe('entering', () => {
    it('takes an LFT typed at the front desk, flags it against the lab’s range, and converts units', async () => {
      const response = await post('/results', frontDeskToken, lftAtSanjeevani());

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body).toMatchObject({
        panel: 'lft',
        documentId: reportA,
        performingFacility: 'Metro Diagnostics',
        source: 'entered',
        recordedBy: { id: frontDeskA.id },
        hospital: { isOwn: true },
      });

      const byCode = Object.fromEntries(
        (response.body as ResultSetBody).results.map((result) => [result.code, result]),
      );

      expect(byCode['1742-6']).toMatchObject({ value: 82, interpretation: 'high', unit: 'U/L' });
      expect(byCode['1975-2']).toMatchObject({
        value: 17.1,
        unit: 'umol/L',
        interpretation: 'normal',
      });
      expect(byCode['1975-2']!.valueCanonical).toBeCloseTo(1, 2);
      // No numeric range: the lab's own flag is used.
      expect(byCode['1751-7']).toMatchObject({ interpretation: 'low' });

      // In panel order, whatever order they were typed in.
      expect((response.body as ResultSetBody).results.map((result) => result.code)).toEqual([
        '1975-2',
        '1742-6',
        '1751-7',
      ]);

      lftAtA = response.body.id;

      const rows = await owner<
        Array<{ category: string; attributed: string | null; entry: string }>
      >`
        SELECT category, attributed_clinician_id::text AS attributed, entry_source AS entry
          FROM observation WHERE group_id = ${lftAtA}
      `;
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.category === 'laboratory' && row.attributed === null)).toBe(
        true,
      );
      expect(rows.every((row) => row.entry === 'direct')).toBe(true);
    });

    it('refuses what is not in the panel, not plausible, or attached to another patient’s report', async () => {
      const cases: Array<[Record<string, unknown>, number]> = [
        [{ results: [{ code: '3016-3', value: 2, unit: 'm[IU]/L' }] }, 400],
        [{ results: [{ code: '1742-6', value: 82, unit: 'mmol/L' }] }, 400],
        [{ results: [{ code: '1742-6', value: 999_999, unit: 'U/L' }] }, 400],
        [{ collectedAt: '2999-01-01T00:00:00Z' }, 400],
        [{ documentId: otherPatientsReport }, 400],
        [{ documentId: randomUUID() }, 400],
        [{ patientId: randomUUID(), documentId: undefined }, 404],
      ];

      for (const [change, status] of cases) {
        const response = await post('/results', frontDeskToken, {
          ...lftAtSanjeevani(),
          ...change,
        });
        expect(response.status, JSON.stringify(change)).toBe(status);
      }
    });

    it('is refused by the database for an admin typist, or a lab result claiming a clinician', async () => {
      const insert = (recordedBy: string, attributed: string | null) =>
        owner.begin(async (tx) => {
          await tx`SELECT set_config('app.system_context', 'on', true)`;
          await tx`
            INSERT INTO observation
              (patient_id, hospital_id, category, code_system, code, display, value_quantity, unit,
               value_canonical, unit_canonical, panel_code, effective_at, recorded_by_staff_id,
               attributed_clinician_id)
            VALUES (${patientId}, ${hospitalA}, 'laboratory', 'http://loinc.org', '1742-6', 'ALT', 40,
                    'U/L', 40, 'U/L', 'lft', now(), ${recordedBy}, ${attributed})
          `;
        });

      await expect(insert(adminA.id, null)).rejects.toThrow(/typed by the front desk/);
      await expect(insert(frontDeskA.id, frontDeskA.id)).rejects.toThrow(
        /observation_attribution_by_category/,
      );
    });

    it('keeps lab results out of vitals and the timeline’s vitals', async () => {
      const vitals = await post('/vitals', clinicianToken, {
        patientId,
        readings: { systolic: 124, diastolic: 82 },
      });
      expect(vitals.status).toBe(201);

      const list = await get(`/patients/${patientId}/vitals`, clinicianToken);
      expect(list.body.sets.map((set: { id: string }) => set.id)).toEqual([vitals.body.id]);

      const timeline = await get(`/patients/${patientId}/timeline`, clinicianToken);
      expect(
        timeline.body.items.filter((item: { kind: string }) => item.kind === 'vitals'),
      ).toHaveLength(1);

      // Nor can a lab set be withdrawn through the vitals route.
      const wrongRoute = await post(`/vitals/${lftAtA}/entered-in-error`, clinicianToken, {
        reason: 'Not vitals',
      });
      expect(wrongRoute.status).toBe(404);
    });

    it('puts the set and its report on the timeline, and its abnormal values on the summary card', async () => {
      type Item = { kind: string; id: string; title: string; detail: string | null; category: string; at: string };

      const timeline = await get(`/patients/${patientId}/timeline`, clinicianToken);
      expect(timeline.status).toBe(200);
      const items = timeline.body.items as Item[];

      // One entry for the set, when the sample was collected, its abnormal values first.
      const result = items.find((item) => item.kind === 'result');
      expect(result).toMatchObject({
        id: lftAtA,
        title: 'Liver function tests (LFT)',
        category: 'observations',
      });
      expect(new Date(result!.at).toISOString()).toBe('2026-09-01T04:00:00.000Z');
      expect(result!.detail).toContain('ALT (SGPT) 82 U/L high');
      expect(result!.detail).toContain('Albumin 3.2 g/dL low');
      expect(result!.detail).toContain('3 tests');

      // The report it was typed from, on the date printed on it.
      expect(items.find((item) => item.kind === 'document' && item.id === reportA)).toMatchObject({
        title: 'Lab report',
        category: 'documents',
      });

      const summary = await get(`/patients/${patientId}/summary`, clinicianToken);
      expect(summary.status).toBe(200);
      expect(
        (summary.body.recentAbnormalResults as Array<{ label: string; interpretation: string }>).map(
          (entry) => [entry.label, entry.interpretation],
        ),
      ).toEqual([
        ['ALT (SGPT)', 'high'],
        ['Albumin', 'low'],
      ]);

      // Another hospital, without consent, sees neither.
      const elsewhere = await get(`/patients/${patientId}/timeline`, clinicianBToken);
      expect(
        (elsewhere.body.items as Item[]).filter(
          (item) => item.kind === 'result' || item.kind === 'document',
        ),
      ).toEqual([]);
    });
  });

  describe('reading across hospitals', () => {
    it('shows another hospital nothing without consent for observations, and not under documents alone', async () => {
      expect((await get(`/patients/${patientId}/results`, clinicianBToken)).body).toEqual({
        sets: [],
        sharedFromOtherHospitals: false,
      });

      const documentsOnly = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['documents'],
        validForDays: 30,
        captureMethod: 'signed_form',
      });
      expect(documentsOnly.status).toBe(201);

      expect((await get(`/patients/${patientId}/results`, clinicianBToken)).body.sets).toEqual([]);
    });

    it('draws one bilirubin trend across both hospitals, in one unit, under consent', async () => {
      const consent = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['observations'],
        validForDays: 30,
        captureMethod: 'signed_form',
      });
      expect(consent.status).toBe(201);

      const atCityGeneral = await post('/results', clinicianBToken, {
        patientId,
        panel: 'lft',
        collectedAt: '2026-09-10T08:00:00+05:30',
        results: [
          { code: '1975-2', value: 1.4, unit: 'mg/dL', referenceLow: 0.2, referenceHigh: 1.2 },
          { code: '1742-6', value: 45, unit: 'U/L', referenceLow: 7, referenceHigh: 56 },
        ],
      });
      expect(atCityGeneral.status).toBe(201);

      const list = await get(`/patients/${patientId}/results?panel=lft`, clinicianBToken);
      expect(list.body.sharedFromOtherHospitals).toBe(true);
      expect(list.body.sets.map((set: ResultSetBody) => set.hospital.isOwn)).toEqual([true, false]);

      const trend = await get(`/patients/${patientId}/results/trends?code=1975-2`, clinicianBToken);
      expect(trend.status).toBe(200);
      expect(trend.body.analyte).toMatchObject({ code: '1975-2', unit: 'mg/dL' });

      const [sanjeevani, cityGeneral] = trend.body.points;
      expect(sanjeevani).toMatchObject({
        hospital: { isOwn: false },
        valueAsEntered: 17.1,
        unitAsEntered: 'umol/L',
        interpretation: 'normal',
      });
      expect(sanjeevani.value).toBeCloseTo(1, 2);
      expect(sanjeevani.referenceHigh).toBeCloseTo(1.2, 2);
      expect(cityGeneral).toMatchObject({
        hospital: { isOwn: true },
        value: 1.4,
        interpretation: 'high',
      });

      const audited = await owner<Array<{ consent: string | null }>>`
        SELECT consent_artefact_id::text AS consent FROM access_log
         WHERE actor_id = ${clinicianB.id} AND resource_type = 'observation'
           AND resource_id = '1975-2'
      `;
      expect(audited.map((row) => row.consent)).toEqual([consent.body.id]);
    });

    it('does not read results for the front desk, which only types them', async () => {
      expect((await get(`/patients/${patientId}/results`, frontDeskToken)).status).toBe(403);
    });

    it('refuses a trend of something no panel measures', async () => {
      const response = await get(
        `/patients/${patientId}/results/trends?code=0000-0`,
        clinicianToken,
      );
      expect(response.status).toBe(400);
    });
  });

  describe('withdrawing', () => {
    it('lets only the recording hospital withdraw a set, whole and once, off lists and trends', async () => {
      const elsewhere = await post(`/results/${lftAtA}/entered-in-error`, clinicianBToken, {
        reason: 'Not ours',
      });
      expect(elsewhere.status).toBe(403);

      const response = await post(`/results/${lftAtA}/entered-in-error`, frontDeskToken, {
        reason: 'Typed from the wrong report',
      });
      expect(response.status).toBe(200);

      const list = await get(`/patients/${patientId}/results`, clinicianToken);
      expect(list.body.sets.map((set: ResultSetBody) => set.id)).not.toContain(lftAtA);

      const trend = await get(`/patients/${patientId}/results/trends?code=1975-2`, clinicianBToken);
      expect(
        trend.body.points.map((point: { hospital: { isOwn: boolean } }) => point.hospital.isOwn),
      ).toEqual([true]);

      const again = await post(`/results/${lftAtA}/entered-in-error`, frontDeskToken, {
        reason: 'Typed from the wrong report',
      });
      expect(again.status).toBe(409);
    });
  });
});
