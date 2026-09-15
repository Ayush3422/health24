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

/**
 * Timeline performance at a realistic synthetic volume (T27).
 *
 * The timeline is a query over the clinical tables, not the materialised
 * projection planning.md §5.1 anticipates (sp3-plan.md). This test is the
 * tripwire: when the query's p95 at this volume crosses the budget, the
 * projection work starts.
 *
 * The volume: one chronic patient seen every fortnight for ten years, half at
 * an Ayurvedic hospital and half at an allopathic one — 240 encounters with
 * two diagnoses, three prescriptions, a set of four vitals and a note each,
 * a procedure at every fourth, and a lab report with its three-test LFT typed
 * from it at every second (SP4) — beside 300 other patients at the same
 * hospitals, so every index has real neighbours to skip.
 */

/** The p95 above which the materialised projection is built. */
const P95_BUDGET_MS = 750;

const SUBJECT_ENCOUNTERS = 240;
const OTHER_PATIENTS = 300;
const ENCOUNTERS_PER_OTHER_PATIENT = 6;
const WARM_UP = 3;
const RUNS = 20;

// Twenty-odd sequential requests per case, each well under a second when healthy.
describe('timeline performance', { timeout: 120_000 }, () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalA: string;
  let hospitalB: string;
  let clinicianA: SeededStaff;
  let clinicianB: SeededStaff;
  let tokenA: string;
  let tokenB: string;
  let patientId: string;

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  async function measure(path: string, token: string) {
    for (let run = 0; run < WARM_UP; run += 1) await get(path, token);

    const timings: number[] = [];
    let last: {
      status: number;
      body: { items: Array<{ hospital: { isOwn: boolean } }>; nextBefore: string | null };
    } | null = null;

    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      const response = await get(path, token);
      timings.push(performance.now() - started);
      last = response;
    }

    const sorted = [...timings].sort((x, y) => x - y);
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
    const median = sorted[Math.floor(sorted.length / 2)]!;

    return { p95, median, last: last! };
  }

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Volume Test', mrnPrefix: 'SVT' });
    const b = await seedHospital({
      name: 'City General Volume Test',
      mrnPrefix: 'GVT',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital.id;
    hospitalB = b.hospital.id;
    clinicianA = a.staff.clinician as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;
    tokenA = await signIn(ctx, clinicianA);
    tokenB = await signIn(ctx, clinicianB);

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    patientId = (await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const [subject] = await tx<Array<{ id: string }>>`
        INSERT INTO patient (name, name_normalized, gender, created_by_hospital_id)
        VALUES ('Chronic Volume Patient', 'chronic volume patient', 'female', ${hospitalA})
        RETURNING id
      `;

      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn) VALUES
          (${subject!.id}, ${hospitalA}, 'SVT-000001'),
          (${subject!.id}, ${hospitalB}, 'GVT-000001')
      `;

      await tx`
        INSERT INTO patient (name, name_normalized, gender, created_by_hospital_id)
        SELECT 'Synthetic Patient ' || g, 'synthetic patient ' || g, 'male', ${hospitalA}
          FROM generate_series(1, ${OTHER_PATIENTS}) g
        RETURNING id
      `;

      await tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
        SELECT p.id, CASE WHEN n % 2 = 0 THEN ${hospitalA}::uuid ELSE ${hospitalB}::uuid END,
               'SYN-' || lpad(n::text, 6, '0')
          FROM (SELECT id, row_number() OVER () AS n FROM patient WHERE name LIKE 'Synthetic Patient %') p
      `;

      // Encounters: the subject's alternate between the hospitals, a fortnight apart.
      await tx`
        INSERT INTO encounter
          (patient_id, hospital_id, class, system_of_medicine, attending_staff_id,
           recorded_by_staff_id, status, started_at, ended_at)
        SELECT ${subject!.id},
               CASE WHEN g % 2 = 0 THEN ${hospitalA}::uuid ELSE ${hospitalB}::uuid END,
               'outpatient',
               (CASE WHEN g % 2 = 0 THEN 'ayurveda' ELSE 'allopathy' END)::system_of_medicine,
               CASE WHEN g % 2 = 0 THEN ${clinicianA.id}::uuid ELSE ${clinicianB.id}::uuid END,
               CASE WHEN g % 2 = 0 THEN ${clinicianA.id}::uuid ELSE ${clinicianB.id}::uuid END,
               'finished',
               now() - g * interval '15 days',
               now() - g * interval '15 days' + interval '20 minutes'
          FROM generate_series(1, ${SUBJECT_ENCOUNTERS}) g
      `;

      await tx`
        INSERT INTO encounter
          (patient_id, hospital_id, class, system_of_medicine, attending_staff_id,
           recorded_by_staff_id, status, started_at, ended_at)
        SELECT l.patient_id, l.hospital_id, 'outpatient',
               (CASE WHEN l.hospital_id = ${hospitalA}::uuid THEN 'ayurveda' ELSE 'allopathy' END)::system_of_medicine,
               CASE WHEN l.hospital_id = ${hospitalA}::uuid THEN ${clinicianA.id}::uuid ELSE ${clinicianB.id}::uuid END,
               CASE WHEN l.hospital_id = ${hospitalA}::uuid THEN ${clinicianA.id}::uuid ELSE ${clinicianB.id}::uuid END,
               'finished',
               now() - g * interval '40 days' - (random() * interval '10 days'),
               now() - g * interval '40 days' + interval '15 minutes'
          FROM patient_hospital_link l
          JOIN patient p ON p.id = l.patient_id AND p.name LIKE 'Synthetic Patient %'
         CROSS JOIN generate_series(1, ${ENCOUNTERS_PER_OTHER_PATIENT}) g
      `;

      // Everything recorded in an encounter, for every encounter seeded above.
      await tx`
        INSERT INTO condition
          (patient_id, hospital_id, encounter_id, is_primary, recorded_by_staff_id, recorded_at)
        SELECT e.patient_id, e.hospital_id, e.id, n = 1, e.attending_staff_id,
               e.started_at + n * interval '2 minutes'
          FROM encounter e CROSS JOIN generate_series(1, 2) n
      `;

      await tx`
        INSERT INTO condition_coding (condition_id, role, code_system_key, code_system_version, code, display)
        SELECT c.id, 'primary', 'namaste', 'DEMO', 'DEMO-NAM-001', 'Amlapitta' FROM condition c
      `;

      await tx`
        INSERT INTO medication_request
          (patient_id, hospital_id, encounter_id, system_of_medicine, medicine_name, strength,
           frequency, route, duration_value, duration_unit, start_date, recorded_by_staff_id, recorded_at)
        SELECT e.patient_id, e.hospital_id, e.id, e.system_of_medicine, 'Formulation ' || n, '500 mg',
               '1-0-1', 'oral', 30, 'days', (e.started_at AT TIME ZONE 'Asia/Kolkata')::date,
               e.attending_staff_id, e.started_at + n * interval '3 minutes'
          FROM encounter e CROSS JOIN generate_series(1, 3) n
      `;

      await tx`
        INSERT INTO observation
          (patient_id, hospital_id, encounter_id, code_system, code, display, value_quantity, unit,
           group_id, effective_at, recorded_by_staff_id, recorded_at)
        SELECT v.patient_id, v.hospital_id, v.id, 'http://loinc.org', r.code, r.display, r.value, r.unit,
               v.group_id, v.started_at + interval '1 minute', v.attending_staff_id,
               v.started_at + interval '1 minute'
          FROM (SELECT e.*, gen_random_uuid() AS group_id FROM encounter e) v
         CROSS JOIN (VALUES
           ('8480-6', 'Systolic blood pressure', 128, 'mm[Hg]'),
           ('8462-4', 'Diastolic blood pressure', 84, 'mm[Hg]'),
           ('8867-4', 'Heart rate', 76, '/min'),
           ('29463-7', 'Body weight', 64, 'kg')
         ) AS r(code, display, value, unit)
      `;

      await tx`
        INSERT INTO clinical_note
          (patient_id, hospital_id, encounter_id, template, body, recorded_by_staff_id, recorded_at)
        SELECT e.patient_id, e.hospital_id, e.id, 'general',
               repeat('Burning after meals, better with diet. Plan: continue and review. ', 6),
               e.attending_staff_id, e.started_at + interval '15 minutes'
          FROM encounter e
      `;

      await tx`
        INSERT INTO procedure
          (patient_id, hospital_id, encounter_id, system_of_medicine, name, performed_at,
           performer_staff_id, outcome, recorded_by_staff_id, recorded_at)
        SELECT e.patient_id, e.hospital_id, e.id, e.system_of_medicine,
               CASE WHEN e.system_of_medicine = 'ayurveda' THEN 'Shirodhara' ELSE 'Upper GI endoscopy' END,
               e.started_at + interval '10 minutes', e.attending_staff_id, 'Tolerated well',
               e.attending_staff_id, e.started_at + interval '12 minutes'
          FROM (SELECT e.*, row_number() OVER (ORDER BY e.started_at) AS n FROM encounter e) e
         WHERE e.n % 4 = 0
      `;

      // A lab report at every second encounter, scanned clean…
      await tx`
        INSERT INTO document_reference
          (patient_id, hospital_id, encounter_id, doc_type, title, report_date, performing_facility,
           recorded_by_staff_id, availability, availability_changed_at, upload_confirmed_at, recorded_at)
        SELECT e.patient_id, e.hospital_id, e.id, 'lab_report', 'LFT',
               (e.started_at AT TIME ZONE 'Asia/Kolkata')::date, 'Metro Diagnostics',
               e.attending_staff_id, 'available', e.started_at, e.started_at,
               e.started_at + interval '18 minutes'
          FROM (SELECT e.*, row_number() OVER (ORDER BY e.started_at) AS n FROM encounter e) e
         WHERE e.n % 2 = 0
      `;

      // …with its LFT typed from it, collected the day before.
      await tx`
        INSERT INTO observation
          (patient_id, hospital_id, encounter_id, document_id, category, source, code_system, code,
           display, value_quantity, unit, value_canonical, unit_canonical, reference_low,
           reference_high, interpretation, panel_code, group_id, effective_at,
           recorded_by_staff_id, recorded_at)
        SELECT d.patient_id, d.hospital_id, d.encounter_id, d.id, 'laboratory', 'entered',
               'http://loinc.org', r.code, r.display, r.value, r.unit, r.value, r.unit, r.low, r.high,
               (CASE WHEN r.value > r.high THEN 'high' ELSE 'normal' END)::result_interpretation,
               'lft', d.group_id, d.recorded_at - interval '1 day', d.recorded_by_staff_id,
               d.recorded_at
          FROM (SELECT d.*, gen_random_uuid() AS group_id FROM document_reference d) d
         CROSS JOIN (VALUES
           ('1742-6', 'Alanine aminotransferase', 62, 'U/L', 7, 56),
           ('1920-8', 'Aspartate aminotransferase', 38, 'U/L', 10, 40),
           ('1975-2', 'Bilirubin.total', 0.9, 'mg/dL', 0.2, 1.2)
         ) AS r(code, display, value, unit, low, high)
      `;

      return subject!.id;
    })) as string;

    await owner`ANALYZE`;

    // City General's front desk records the patient's consent to see everything.
    const consent = await ctx
      .http()
      .post(`/api/v1/patients/${patientId}/consents`)
      .set('Authorization', `Bearer ${await signIn(ctx, b.staff.frontDesk as SeededStaff)}`)
      .send({
        dataCategories: [
          'encounters',
          'diagnoses',
          'medications',
          'allergies',
          'observations',
          'notes',
          'procedures',
          'documents',
        ],
        validForDays: 365,
        captureMethod: 'signed_form',
      });
    expect(consent.status).toBe(201);
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('seeds the volume it claims', async () => {
    const [counts] = await owner<Array<Record<string, number>>>`
      SELECT (SELECT count(*)::int FROM encounter) AS encounters,
             (SELECT count(*)::int FROM condition) AS conditions,
             (SELECT count(*)::int FROM medication_request) AS prescriptions,
             (SELECT count(*)::int FROM observation WHERE category = 'vital_signs') AS vitals,
             (SELECT count(*)::int FROM observation WHERE category = 'laboratory') AS lab_results,
             (SELECT count(*)::int FROM document_reference) AS documents,
             (SELECT count(*)::int FROM clinical_note) AS notes,
             (SELECT count(*)::int FROM procedure) AS procedures,
             (SELECT count(*)::int FROM encounter WHERE patient_id = ${patientId}) AS subject_encounters
    `;

    const encounters = SUBJECT_ENCOUNTERS + OTHER_PATIENTS * ENCOUNTERS_PER_OTHER_PATIENT;
    const documents = Math.floor(encounters / 2);
    expect(counts).toMatchObject({
      encounters,
      conditions: encounters * 2,
      prescriptions: encounters * 3,
      vitals: encounters * 4,
      lab_results: documents * 3,
      documents,
      notes: encounters,
      subject_encounters: SUBJECT_ENCOUNTERS,
    });

    console.info(`[timeline performance] seeded ${JSON.stringify(counts)}`);
  });

  it(`serves another hospital's first page, under consent, within ${P95_BUDGET_MS} ms at p95`, async () => {
    const { p95, median, last } = await measure(
      `/patients/${patientId}/timeline?limit=100`,
      tokenB,
    );

    console.info(
      `[timeline performance] cross-hospital first page: median ${median.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`,
    );

    expect(last.status).toBe(200);
    expect(last.body.items).toHaveLength(100);
    expect(last.body.nextBefore).not.toBeNull();
    expect(last.body.items.some((item) => !item.hospital.isOwn)).toBe(true);
    expect(p95, 'over budget: build the materialised timeline projection').toBeLessThan(
      P95_BUDGET_MS,
    );
  });

  it(`serves a page eight years back within ${P95_BUDGET_MS} ms at p95`, async () => {
    const before = new Date(Date.now() - 8 * 365 * 86_400_000).toISOString();
    const { p95, median, last } = await measure(
      `/patients/${patientId}/timeline?limit=100&before=${encodeURIComponent(before)}`,
      tokenB,
    );

    console.info(
      `[timeline performance] cross-hospital deep page: median ${median.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`,
    );

    expect(last.status).toBe(200);
    expect(last.body.items).toHaveLength(100);
    expect(p95, 'over budget: build the materialised timeline projection').toBeLessThan(
      P95_BUDGET_MS,
    );
  });

  it(`serves the hospital's own record within ${P95_BUDGET_MS} ms at p95`, async () => {
    const { p95, median, last } = await measure(
      `/patients/${patientId}/timeline?limit=100&scope=own`,
      tokenA,
    );

    console.info(
      `[timeline performance] own record: median ${median.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`,
    );

    expect(last.status).toBe(200);
    expect(last.body.items.every((item) => item.hospital.isOwn)).toBe(true);
    expect(p95, 'over budget: build the materialised timeline projection').toBeLessThan(
      P95_BUDGET_MS,
    );
  });
});
