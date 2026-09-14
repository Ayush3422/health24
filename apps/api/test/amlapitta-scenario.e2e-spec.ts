import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  createTestApp,
  loadDemoTerminology,
  resetDatabase,
  seedHospital,
  seedPlatformUser,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

type TimelineItem = {
  kind: string;
  title: string;
  detail: string | null;
  hospital: { name: string; isOwn: boolean };
};

/**
 * The acceptance scenario (sp3-plan.md; planning.md §1), end to end through
 * the API, as the final smoke test (T28).
 *
 * A patient is treated for Amlapitta at an Ayurvedic hospital for four months,
 * then consults a gastroenterologist at an allopathic one. The physician opens
 * the timeline and sees the diagnosis in ICD-11, the formulations with their
 * dates and durations, and the allergy — and the patient explains nothing.
 * With consent revoked, the physician sees nothing from the Ayurvedic
 * hospital, and the attempt is audited.
 *
 * Tests already run and their values, and reports already taken, arrive with
 * SP4 and are not part of this scenario yet.
 *
 * Runs on the synthetic demo terminology: DEMO-NAM-001 stands in for
 * Amlapitta, with a TM2 translation and a biomedical mapping a curator must
 * approve before it is attached.
 */
describe('the Amlapitta scenario', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  const SANJEEVANI = 'Sanjeevani Ayurvedic Hospital';
  const PATIENT = {
    name: 'Lakshmi Amlapitta',
    gender: 'female',
    dateOfBirth: '1968-04-12',
    phone: '9820088881',
  };

  let curatorToken: string;
  let sanjeevaniDeskToken: string;
  let vaidyaToken: string;
  let cityDeskToken: string;
  let gastroenterologist: SeededStaff;
  let gastroToken: string;

  let patientId: string;
  let firstVisit: string;
  let consentId: string;
  const formulations: Array<{ name: string; startDate: string }> = [];

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  /** A calendar date some days ago, in India Standard Time. */
  const istDaysAgo = (days: number) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.now() - days * 86_400_000));

  const sharedItems = async (token: string): Promise<TimelineItem[]> => {
    const timeline = await get(`/patients/${patientId}/timeline`, token);
    expect(timeline.status).toBe(200);
    return (timeline.body.items as TimelineItem[]).filter((item) => !item.hospital.isOwn);
  };

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();
    ctx = await createTestApp();

    const sanjeevani = await seedHospital({ name: SANJEEVANI, mrnPrefix: 'SAH' });
    const cityGeneral = await seedHospital({
      name: 'City General Hospital',
      mrnPrefix: 'CGH',
      facilityType: 'allopathic',
    });

    curatorToken = await signIn(
      ctx,
      await seedPlatformUser({
        role: 'terminology_curator',
        email: 'curator@smoke.example.in',
        name: 'Smoke Curator',
      }),
    );
    sanjeevaniDeskToken = await signIn(ctx, sanjeevani.staff.frontDesk as SeededStaff);
    vaidyaToken = await signIn(ctx, sanjeevani.staff.clinician as SeededStaff);
    cityDeskToken = await signIn(ctx, cityGeneral.staff.frontDesk as SeededStaff);
    gastroenterologist = cityGeneral.staff.clinician as SeededStaff;
    gastroToken = await signIn(ctx, gastroenterologist);

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('0. a curator approves the biomedical mapping for Amlapitta', async () => {
    const [element] = await owner<Array<{ id: string }>>`
      SELECT e.id
        FROM concept_map_element e
        JOIN concept_map m ON m.id = e.concept_map_id
        JOIN code_system t ON t.id = m.target_system_id
       WHERE t.key = 'icd11-mms' AND e.source_code = 'DEMO-NAM-001' AND e.status = 'proposed'
    `;

    const review = await post(`/terminology/map-elements/${element!.id}/review`, curatorToken, {
      decision: 'approve',
      comment: 'Checked against the demo source',
    });

    expect(review.status).toBe(200);
    expect(review.body.status).toBe('approved');
  });

  it('1. Sanjeevani registers the patient, and a vaidya diagnoses Amlapitta', async () => {
    const registered = await post('/patients', sanjeevaniDeskToken, PATIENT);
    expect(registered.status).toBe(201);
    expect(registered.body.linkedExisting).toBe(false);
    patientId = registered.body.patient.id;

    const encounter = await post('/encounters', vaidyaToken, {
      patientId,
      chiefComplaint: 'Burning after meals for three months',
    });
    expect(encounter.body.systemOfMedicine).toBe('ayurveda');
    firstVisit = encounter.body.id;

    const allergy = await post('/allergies', vaidyaToken, {
      patientId,
      encounterId: firstVisit,
      substance: 'Penicillin',
      category: 'medication',
      criticality: 'high',
      reaction: 'Hives',
    });
    expect(allergy.status).toBe(201);

    const diagnosis = await post('/diagnoses', vaidyaToken, {
      encounterId: firstVisit,
      code: 'DEMO-NAM-001',
      isPrimary: true,
    });
    expect(diagnosis.status).toBe(201);
    expect(diagnosis.body.codings).toMatchObject({
      primary: { system: 'namaste', code: 'DEMO-NAM-001' },
      translated: { system: 'icd11-tm2', code: 'DEMO-TM2-01' },
      advisory: { system: 'icd11-mms', code: 'DEMO-MMS-01' },
    });
  });

  it('2. and prescribes two formulations over four months', async () => {
    formulations.push({ name: 'Avipattikar churna', startDate: istDaysAgo(120) });

    const first = await post('/prescriptions', vaidyaToken, {
      encounterId: firstVisit,
      medicineName: formulations[0]!.name,
      dose: { quantity: 5, unit: 'g' },
      frequency: '1-0-1',
      route: 'oral',
      duration: { value: 2, unit: 'months' },
      startDate: formulations[0]!.startDate,
      vehicle: 'warm water',
      foodTiming: 'before_food',
    });
    expect(first.status).toBe(201);

    expect((await post(`/encounters/${firstVisit}/finish`, vaidyaToken)).status).toBe(200);

    const followUp = await post('/encounters', vaidyaToken, {
      patientId,
      chiefComplaint: 'Follow-up: symptoms persist',
    });

    formulations.push({ name: 'Sutashekhar rasa', startDate: istDaysAgo(60) });

    const second = await post('/prescriptions', vaidyaToken, {
      encounterId: followUp.body.id,
      medicineName: formulations[1]!.name,
      dose: { quantity: 1, unit: 'tablet' },
      frequency: '1-0-1',
      route: 'oral',
      duration: { value: 2, unit: 'months' },
      startDate: formulations[1]!.startDate,
    });
    expect(second.status).toBe(201);
  });

  it('3. the patient registers at City General and is linked to the existing record', async () => {
    const registered = await post('/patients', cityDeskToken, PATIENT);

    expect(registered.status).toBe(201);
    expect(registered.body.linkedExisting).toBe(true);
    expect(registered.body.patient.id).toBe(patientId);
    expect(registered.body.patient.mrn).toMatch(/^CGH-/);

    // Linked is not shared: without consent the physician sees nothing from Sanjeevani.
    expect(await sharedItems(gastroToken)).toEqual([]);
  });

  it('4. City General’s front desk records the patient’s consent', async () => {
    const consent = await post(`/patients/${patientId}/consents`, cityDeskToken, {
      dataCategories: ['encounters', 'diagnoses', 'medications', 'allergies'],
      validForDays: 180,
      captureMethod: 'signed_form',
    });

    expect(consent.status).toBe(201);
    consentId = consent.body.id;
  });

  it('5. the gastroenterologist sees the diagnosis in ICD-11, the formulations and the allergy', async () => {
    const items = await sharedItems(gastroToken);
    expect(items.every((item) => item.hospital.name === SANJEEVANI)).toBe(true);

    const diagnosis = items.find((item) => item.kind === 'diagnosis');
    expect(diagnosis?.title).toContain('(DEMO-NAM-001)');
    expect(diagnosis?.detail).toContain('DEMO-TM2-01');

    const prescriptions = items.filter((item) => item.kind === 'prescription');
    expect(prescriptions.map((item) => item.title).sort()).toEqual(
      formulations.map((formulation) => formulation.name).sort(),
    );
    expect(prescriptions.every((item) => item.detail?.includes('for 2 months'))).toBe(true);

    // The problem list carries the biomedical code a curator approved as well.
    const problems = JSON.stringify(
      (await get(`/patients/${patientId}/problems`, gastroToken)).body,
    );
    expect(problems).toContain('DEMO-TM2-01');
    expect(problems).toContain('DEMO-MMS-01');

    // Each formulation with its start date and duration, at its visit.
    const visits = (await get(`/encounters?patientId=${patientId}&limit=100`, gastroToken)).body
      .results as Array<{ id: string; hospital: { isOwn: boolean } }>;
    const prescribed = JSON.stringify(
      await Promise.all(
        visits
          .filter((visit) => !visit.hospital.isOwn)
          .map(
            async (visit) => (await get(`/encounters/${visit.id}/prescriptions`, gastroToken)).body,
          ),
      ),
    );
    for (const formulation of formulations) {
      expect(prescribed).toContain(formulation.name);
      expect(prescribed).toContain(formulation.startDate);
    }

    const banner = await get(`/patients/${patientId}/allergies`, gastroToken);
    expect(banner.body.allergies).toEqual([
      expect.objectContaining({
        substance: 'Penicillin',
        criticality: 'high',
        hospital: expect.objectContaining({ name: SANJEEVANI, isOwn: false }),
      }),
    ]);
  });

  it('6. the patient explains nothing: the summary card has it at a glance', async () => {
    const summary = await get(`/patients/${patientId}/summary`, gastroToken);

    expect(summary.status).toBe(200);
    expect(summary.body.allergies.allergies).toHaveLength(1);
    expect(summary.body.problems.problems).toHaveLength(1);
    expect(summary.body.sharing.categories).toEqual(
      expect.arrayContaining(['diagnoses', 'medications', 'allergies']),
    );
  });

  it('7. with consent revoked, nothing from Sanjeevani is shown, and the attempt is audited', async () => {
    const revoked = await post(`/consents/${consentId}/revoke`, cityDeskToken, {
      reason: 'Patient withdrew consent',
    });
    expect(revoked.status).toBe(200);

    const [{ revokedAt }] = (await owner<Array<{ revokedAt: string }>>`
      SELECT revoked_at::text AS "revokedAt" FROM consent_artefact WHERE id = ${consentId}
    `) as [{ revokedAt: string }];

    expect(await sharedItems(gastroToken)).toEqual([]);
    expect((await get(`/patients/${patientId}/allergies`, gastroToken)).body.allergies).toEqual([]);
    expect(
      JSON.stringify((await get(`/patients/${patientId}/problems`, gastroToken)).body),
    ).not.toContain('DEMO-NAM-001');

    const attempts = await owner<Array<{ resource_type: string; consent: string | null }>>`
      SELECT resource_type, consent_artefact_id::text AS consent
        FROM access_log
       WHERE actor_id = ${gastroenterologist.id} AND action = 'read' AND at > ${revokedAt}::timestamptz
    `;
    expect(attempts.map((row) => row.resource_type)).toEqual(
      expect.arrayContaining(['timeline', 'allergy_intolerance', 'condition']),
    );
    expect(attempts.every((row) => row.consent === null)).toBe(true);

    const [revocation] = await owner<Array<{ action: string }>>`
      SELECT action FROM access_log
       WHERE resource_type = 'consent_artefact' AND resource_id = ${consentId} AND action = 'update'
    `;
    expect(revocation?.action).toBe('update');
  });
});
