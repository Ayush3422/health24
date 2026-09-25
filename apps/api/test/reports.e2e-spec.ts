import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { ReportsService } from '../src/modules/reports/reports.service';
import {
  appRoleDb,
  createTestApp,
  loadDemoTerminology,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

const istDay = (offsetDays = 0): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );

type MorbidityReturn = {
  id: string;
  rows: Array<{
    namasteCode: string;
    namasteDisplay: string;
    icd11Code: string | null;
    total: number;
    male: number;
    female: number;
  }>;
  total: number;
  submittedAt: string | null;
  reference: string | null;
};

/**
 * Reporting (sp6-plan.md, Phase 8, Decision S1): the hospital's own numbers,
 * counted from its own record, and the return it owes the ministry.
 */
describe('reports', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalId: string;
  let adminToken: string;
  let deskToken: string;
  let clinicianToken: string;
  let otherAdminToken: string;
  let clinician: SeededStaff;

  let patientId: string;

  const post = (path: string, bearer: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`).send(body);

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  /**
   * A NAMASTE code the vocabulary does not know, recorded straight into the
   * record: the shape a diagnosis has when nothing was there to map it, which
   * is what the data-quality report is looking for.
   */
  const diagnoseUnmapped = async (options: {
    encounterId: string;
    patient: string;
    code: string;
    display: string;
  }) => {
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;

      const [condition] = await tx<Array<{ id: string }>>`
        INSERT INTO condition (patient_id, hospital_id, encounter_id, clinical_status,
                               verification_status, is_primary, attributed_clinician_id,
                               recorded_by_staff_id, recorded_at)
        VALUES (${options.patient}, ${hospitalId}, ${options.encounterId}, 'active', 'confirmed',
                true, ${clinician.id}, ${clinician.id}, now())
        RETURNING id
      `;

      await tx`
        INSERT INTO condition_coding (condition_id, role, code_system_key, code_system_version,
                                      code, display)
        VALUES (${condition!.id}, 'primary', 'namaste', '2024', ${options.code}, ${options.display})
      `;
    });
  };

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Report Test', mrnPrefix: 'SRT' });
    const b = await seedHospital({
      name: 'City General Report Test',
      mrnPrefix: 'CGR',
      facilityType: 'allopathic',
    });

    hospitalId = a.hospital.id;
    clinician = a.staff.clinician as SeededStaff;

    adminToken = await signIn(ctx, a.staff.admin as SeededStaff);
    deskToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    clinicianToken = await signIn(ctx, clinician);
    otherAdminToken = await signIn(ctx, b.staff.admin as SeededStaff);

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    patientId = (
      await post('/patients', deskToken, {
        name: 'Counted Patient',
        gender: 'female',
        dateOfBirth: '1977-02-02',
        phone: '9820120001',
      })
    ).body.patient.id;

    const secondPatient = (
      await post('/patients', deskToken, {
        name: 'Second Counted',
        gender: 'male',
        dateOfBirth: '1968-06-06',
        phone: '9820120002',
      })
    ).body.patient.id;

    // Two visits today, one of them inpatient, and three coded diagnoses.
    const first = (await post('/encounters', clinicianToken, { patientId })).body.id;
    const second = (
      await post('/encounters', clinicianToken, { patientId: secondPatient, class: 'inpatient' })
    ).body.id;

    // Two dual-coded the way a clinician records them, one for each patient.
    for (const encounter of [first, second]) {
      const recorded = await post('/diagnoses', clinicianToken, {
        encounterId: encounter,
        code: 'DEMO-NAM-001',
      });
      expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    }

    // One with no ICD-11 code, which the data-quality report should notice.
    await diagnoseUnmapped({
      encounterId: first,
      patient: patientId,
      code: 'AYU-JVARA',
      display: 'Jvara',
    });

    await post('/prescriptions', clinicianToken, {
      encounterId: first,
      medicineName: 'Avipattikar churna',
      strength: '5 g',
      frequency: '1-0-1',
      route: 'oral',
      durationValue: 14,
      durationUnit: 'days',
    });

    // Something billed and half paid, for the revenue report.
    const item = (
      await post('/catalogue', adminToken, {
        code: 'OPD-GEN',
        name: 'General consultation',
        category: 'consultation',
        unit: 'visit',
        pricePaise: 40000,
      })
    ).body;

    await post('/charges', deskToken, { encounterId: first, itemId: item.id });
    const invoice = (await post('/invoices', deskToken, { encounterId: first })).body;

    await post(`/invoices/${invoice.id}/entries`, deskToken, {
      kind: 'payment',
      method: 'cash',
      amountPaise: 25000,
    });
  }, 240_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('counts the day’s visits, and breaks them down', async () => {
    const today = istDay();
    const report = await get(`/reports/footfall?from=${today}&to=${today}&by=class`, adminToken);

    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.total).toBe(2);
    expect(report.body.byDay).toEqual([{ date: today, count: 2 }]);

    const classes = report.body.breakdown as Array<{ key: string; count: number }>;
    expect(classes.find((row) => row.key === 'outpatient')?.count).toBe(1);
    expect(classes.find((row) => row.key === 'inpatient')?.count).toBe(1);

    const byClinician = await get(
      `/reports/footfall?from=${today}&to=${today}&by=clinician`,
      adminToken,
    );
    expect(byClinician.body.breakdown[0]).toMatchObject({ count: 2 });
  });

  it('counts diagnoses from the codes on them, commonest first', async () => {
    const today = istDay();
    const report = await get(`/reports/diagnoses?from=${today}&to=${today}`, adminToken);

    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.total).toBe(3);

    const [commonest] = report.body.diagnoses;
    expect(commonest).toMatchObject({
      key: 'DEMO-NAM-001',
      label: 'Amlapitta',
      count: 2,
      icd11Code: 'DEMO-TM2-01',
    });

    // And the one with no mapping is counted, with nothing invented for it.
    const jvara = report.body.diagnoses.find((row: { key: string }) => row.key === 'AYU-JVARA');
    expect(jvara).toMatchObject({ count: 1, icd11Code: null });
  });

  it('counts what was prescribed, and what money came and went', async () => {
    const today = istDay();

    const prescriptions = await get(`/reports/prescriptions?from=${today}&to=${today}`, adminToken);
    expect(prescriptions.body.medicines[0]).toMatchObject({
      label: 'Avipattikar churna',
      count: 1,
    });
    expect(prescriptions.body.bySystem[0]).toMatchObject({ count: 1 });

    const revenue = await get(`/reports/revenue?from=${today}&to=${today}`, adminToken);
    expect(revenue.status, JSON.stringify(revenue.body)).toBe(200);
    expect(revenue.body).toMatchObject({
      invoicedPaise: 40000,
      receivedPaise: 25000,
      creditedPaise: 0,
      outstandingPaise: 15000,
    });
    expect(revenue.body.byCategory[0]).toMatchObject({ key: 'consultation', amountPaise: 40000 });
    expect(revenue.body.byMethod[0]).toMatchObject({ key: 'cash', amountPaise: 25000 });
  });

  it('keeps a finished day once it has been counted, and never keeps today', async () => {
    const reports = ctx.app.get(ReportsService);
    const yesterday = istDay(-1);

    await reports.summariseDay(hospitalId, yesterday);

    const kept = await owner<Array<{ metric: string; value: string }>>`
      SELECT metric, value::text FROM daily_summary
       WHERE hospital_id = ${hospitalId} AND ist_date = ${yesterday}
    `;
    expect(kept.map((row) => row.metric).sort()).toEqual(['encounters', 'invoiced_paise']);

    // Asking for today is refused by the service, quietly and on purpose.
    await reports.summariseDay(hospitalId, istDay());

    const today = await owner<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM daily_summary
       WHERE hospital_id = ${hospitalId} AND ist_date = ${istDay()}
    `;
    expect(today[0]!.count).toBe(0);
  });

  it('counts a day nobody has counted, rather than leaving a hole', async () => {
    const from = istDay(-3);
    const to = istDay();

    const report = await get(`/reports/footfall?from=${from}&to=${to}`, adminToken);
    expect(report.body.byDay).toHaveLength(4);

    // The finished days are now kept; today is not.
    const kept = await owner<Array<{ ist_date: string }>>`
      SELECT to_char(ist_date, 'YYYY-MM-DD') AS ist_date FROM daily_summary
       WHERE hospital_id = ${hospitalId} AND metric = 'encounters'
    ORDER BY ist_date
    `;
    expect(kept.map((row) => row.ist_date)).toEqual([istDay(-3), istDay(-2), istDay(-1)]);
  });

  it('says what the record has left unfinished', async () => {
    const report = await get('/reports/data-quality', adminToken);
    expect(report.status).toBe(200);

    const checks = report.body.checks as Array<{ key: string; count: number }>;
    expect(checks.find((check) => check.key === 'unmapped_diagnoses')?.count).toBe(1);
    expect(checks.map((check) => check.key)).toContain('stale_orders');
    expect(checks.every((check) => typeof check.count === 'number')).toBe(true);
  });

  it('generates the Ayush morbidity return from the coded diagnoses', async () => {
    const today = istDay();
    const generated = await post('/statutory-returns', adminToken, { from: today, to: today });

    expect(generated.status, JSON.stringify(generated.body)).toBe(201);
    const filed = generated.body as MorbidityReturn;

    expect(filed.total).toBe(3);
    expect(filed.rows[0]).toMatchObject({
      namasteCode: 'DEMO-NAM-001',
      icd11Code: 'DEMO-TM2-01',
      total: 2,
      male: 1,
      female: 1,
    });
    expect(filed.submittedAt).toBeNull();

    // As a spreadsheet, which is how a ministry asks for it.
    const csv = await get(`/statutory-returns/${filed.id}/csv`, adminToken);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toContain('NAMASTE code');
    expect(csv.text).toContain('DEMO-NAM-001');
  });

  it('keeps what was submitted exactly as it was sent', async () => {
    const [filed] = (await get('/statutory-returns', adminToken)).body.returns as MorbidityReturn[];

    const submitted = await post(`/statutory-returns/${filed!.id}/submit`, adminToken, {
      reference: 'AYUSH/2026/00451',
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toMatchObject({ reference: 'AYUSH/2026/00451' });
    expect(submitted.body.submittedAt).toBeTruthy();

    // Submitting twice says so rather than pretending.
    expect((await post(`/statutory-returns/${filed!.id}/submit`, adminToken, {})).status).toBe(409);

    // A diagnosis corrected afterwards does not change what was sent.
    const { client: app, close } = appRoleDb();
    try {
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`UPDATE statutory_return SET contents = '[]'::jsonb WHERE id = ${filed!.id}`;
        }),
      ).rejects.toThrow(/permission denied|immutable/);
    } finally {
      await close();
    }

    const after = await get(`/statutory-returns/${filed!.id}`, adminToken);
    expect(after.body.total).toBe(3);
  });

  it('is the hospital’s own, and not a clinician’s or a desk clerk’s to read', async () => {
    const today = istDay();

    const theirs = await get(`/reports/footfall?from=${today}&to=${today}`, otherAdminToken);
    expect(theirs.status).toBe(200);
    expect(theirs.body.total).toBe(0);

    expect((await get('/statutory-returns', otherAdminToken)).body.returns).toEqual([]);
    expect((await get(`/reports/revenue?from=${today}&to=${today}`, clinicianToken)).status).toBe(
      403,
    );
    expect((await get('/reports/data-quality', deskToken)).status).toBe(403);
  });

  it('refuses a period that ends before it starts', async () => {
    const backwards = await get(
      `/reports/footfall?from=${istDay()}&to=${istDay(-5)}`,
      adminToken,
    );
    expect(backwards.status, JSON.stringify(backwards.body)).toBe(400);
  });
});
