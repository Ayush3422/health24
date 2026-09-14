import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  createTestApp,
  loadDemoTerminology,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

type Item = {
  kind: string;
  id: string;
  at: string;
  category: string;
  hospital: { id: string; isOwn: boolean };
  systemOfMedicine: string | null;
  title: string;
  detail: string | null;
};

/**
 * Phase 8: consent recorded at the desk, emergency access, the timeline, the
 * summary card and the coding review queue.
 *
 * The patient is registered at an Ayurvedic hospital (A), which records a full
 * consultation, and later arrives at an allopathic one (B). What B sees of A's
 * record is decided by the consent B's front desk records — or, in an
 * emergency, by the access a clinician takes and the hospital later reviews.
 */
describe('consent, emergency access, timeline and coding review', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalA: { id: string };
  let hospitalB: { id: string };
  let clinicianA: SeededStaff;
  let clinicianB: SeededStaff;
  let frontDeskB: SeededStaff;
  let adminB: SeededStaff;
  let tokenA: string;
  let tokenB: string;
  let frontDeskAToken: string;
  let frontDeskBToken: string;
  let adminAToken: string;
  let adminBToken: string;

  let patientId: string;
  let patientOnlyAtA: string;
  let diagnosisId: string;

  let signedConsentId: string;
  let breakGlassId: string;

  const EMERGENCY_REASON = 'Brought in unconscious; needs history before anaesthesia';

  const get = (path: string, token: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);

  async function asSystem<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  async function timeline(
    token: string,
    query = '',
  ): Promise<{ items: Item[]; nextBefore: string | null; sharedCategories: string[] }> {
    const response = await get(`/patients/${patientId}/timeline${query}`, token);
    expect(response.status).toBe(200);
    return response.body;
  }

  const shared = (items: Item[]) => items.filter((item) => !item.hospital.isOwn);

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Phase 8 Test', mrnPrefix: 'SPT' });
    const b = await seedHospital({
      name: 'City General Phase 8 Test',
      mrnPrefix: 'GPT',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital;
    hospitalB = b.hospital;
    clinicianA = a.staff.clinician as SeededStaff;
    clinicianB = b.staff.clinician as SeededStaff;
    frontDeskB = b.staff.frontDesk as SeededStaff;
    adminB = b.staff.admin as SeededStaff;

    tokenA = await signIn(ctx, clinicianA);
    tokenB = await signIn(ctx, clinicianB);
    frontDeskAToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    frontDeskBToken = await signIn(ctx, frontDeskB);
    adminAToken = await signIn(ctx, a.staff.admin as SeededStaff);
    adminBToken = await signIn(ctx, adminB);

    const registered = await post('/patients', frontDeskAToken, {
      name: 'Kamala Timeline',
      gender: 'female',
      dateOfBirth: '1966-02-11',
      phone: '9820066661',
    });
    patientId = registered.body.patient.id;

    const other = await post('/patients', frontDeskAToken, {
      name: 'Suresh Elsewhere',
      gender: 'male',
      dateOfBirth: '1960-09-30',
      phone: '9820066662',
    });
    patientOnlyAtA = other.body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await asSystem(
      (tx) => tx`
      INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
      VALUES (${patientId}, ${hospitalB.id}, 'GPT-000001')
    `,
    );

    // A full Ayurvedic consultation at A.
    const encounter = await post('/encounters', tokenA, {
      patientId,
      chiefComplaint: 'Burning after meals',
    });
    const encounterId = encounter.body.id as string;

    expect(
      (
        await post('/allergies', tokenA, {
          patientId,
          encounterId,
          substance: 'Penicillin',
          category: 'medication',
          criticality: 'high',
          reaction: 'Hives',
        })
      ).status,
    ).toBe(201);

    const diagnosis = await post('/diagnoses', tokenA, {
      encounterId,
      code: 'DEMO-NAM-001',
      isPrimary: true,
    });
    expect(diagnosis.status).toBe(201);
    diagnosisId = diagnosis.body.id;

    expect(
      (
        await post('/vitals', tokenA, {
          patientId,
          encounterId,
          readings: { systolic: 128, diastolic: 84, heartRate: 76 },
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await post('/notes', tokenA, {
          encounterId,
          template: 'general',
          sections: { subjective: 'Burning in the chest after meals' },
        })
      ).status,
    ).toBe(201);

    expect((await post('/procedures', tokenA, { encounterId, name: 'Shirodhara' })).status).toBe(
      201,
    );

    // And B's own first visit.
    expect((await post('/encounters', tokenB, { patientId })).status).toBe(201);
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  describe('timeline', () => {
    it('streams the hospital’s own record newest first, across every kind', async () => {
      const page = await timeline(tokenA);

      expect(new Set(page.items.map((item) => item.kind))).toEqual(
        new Set(['encounter', 'allergy', 'diagnosis', 'vitals', 'note', 'procedure']),
      );
      expect(page.items.every((item) => item.hospital.isOwn)).toBe(true);
      expect(page.sharedCategories).toEqual([]);

      const times = page.items.map((item) => item.at);
      expect(times).toEqual([...times].sort().reverse());

      const vitals = page.items.find((item) => item.kind === 'vitals');
      expect(vitals?.detail).toContain('BP 128/84 mmHg');
      expect(vitals?.detail).toContain('Pulse 76 /min');

      const diagnosis = page.items.find((item) => item.kind === 'diagnosis');
      expect(diagnosis).toMatchObject({ id: diagnosisId, systemOfMedicine: 'ayurveda' });
      expect(diagnosis?.title).toContain('(DEMO-NAM-001)');
      expect(diagnosis?.detail).toContain('TM2');

      const encounter = page.items.find((item) => item.kind === 'encounter');
      expect(encounter).toMatchObject({ title: 'OPD encounter' });
      expect(encounter?.detail).toContain('in progress');
    });

    it('filters by category and pages backwards without losing or repeating an entry', async () => {
      const allergies = await timeline(tokenA, '?categories=allergies');
      expect(allergies.items.map((item) => item.kind)).toEqual(['allergy']);

      const all = await timeline(tokenA);
      const first = await timeline(tokenA, '?limit=4');
      expect(first.items).toHaveLength(4);
      expect(first.nextBefore).not.toBeNull();

      const second = await timeline(
        tokenA,
        `?limit=4&before=${encodeURIComponent(first.nextBefore!)}`,
      );
      expect(second.nextBefore).toBeNull();

      expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
        all.items.map((item) => item.id),
      );
    });

    it('shows another hospital nothing without consent', async () => {
      const page = await timeline(tokenB);

      expect(page.items.map((item) => item.kind)).toEqual(['encounter']);
      expect(shared(page.items)).toEqual([]);
      expect(page.sharedCategories).toEqual([]);
    });
  });

  describe('consent at the front desk', () => {
    it('records a signed consent, and the timeline widens to exactly its categories', async () => {
      const response = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['allergies', 'diagnoses'],
        validForDays: 30,
        captureMethod: 'signed_form',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        patientId,
        dataCategories: ['allergies', 'diagnoses'],
        status: 'active',
        captureMethod: 'signed_form',
        recordedBy: { id: frontDeskB.id },
        emergencyReason: null,
        review: null,
      });

      const days =
        (Date.parse(response.body.expiresAt) - Date.parse(response.body.grantedAt)) / 86_400_000;
      expect(days).toBeCloseTo(30, 3);
      signedConsentId = response.body.id;

      const page = await timeline(tokenB);
      expect(new Set(shared(page.items).map((item) => item.kind))).toEqual(
        new Set(['allergy', 'diagnosis']),
      );
      expect([...page.sharedCategories].sort()).toEqual(['allergies', 'diagnoses']);

      // The diagnosis is shared; the encounter it belongs to is not.
      expect(
        shared(page.items).find((item) => item.kind === 'diagnosis')?.systemOfMedicine,
      ).toBeNull();

      const audited = await owner<Array<{ category: string }>>`
        SELECT resource_id AS category
          FROM access_log
         WHERE actor_id = ${clinicianB.id} AND resource_type = 'timeline'
           AND consent_artefact_id = ${signedConsentId}
      `;
      expect(new Set(audited.map((row) => row.category))).toEqual(
        new Set(['allergies', 'diagnoses']),
      );
    });

    it('refuses consent that cannot be verified, or for a patient not registered here', async () => {
      const unwitnessed = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['allergies'],
        validForDays: 30,
        captureMethod: 'verbal_witnessed',
      });
      expect(unwitnessed.status).toBe(400);

      const nothing = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: [],
        validForDays: 30,
        captureMethod: 'signed_form',
      });
      expect(nothing.status).toBe(400);

      const forever = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['allergies'],
        validForDays: 4000,
        captureMethod: 'signed_form',
      });
      expect(forever.status).toBe(400);

      const selfDeclared = await post(`/patients/${patientId}/consents`, frontDeskBToken, {
        dataCategories: ['allergies'],
        validForDays: 30,
        captureMethod: 'break_glass',
      });
      expect(selfDeclared.status).toBe(400);

      const stranger = await post(`/patients/${patientOnlyAtA}/consents`, frontDeskBToken, {
        dataCategories: ['allergies'],
        validForDays: 30,
        captureMethod: 'signed_form',
      });
      expect(stranger.status).toBe(404);
    });

    it('lists consents with the status they have today, including lapsed ones', async () => {
      await asSystem(
        (tx) => tx`
        INSERT INTO consent_artefact
          (patient_id, grantee_hospital_id, data_categories, granted_at, expires_at,
           capture_method, witness_name, recorded_by_staff_id)
        VALUES (${patientId}, ${hospitalB.id}, '{notes}', now() - interval '40 days',
                now() - interval '10 days', 'verbal_witnessed', 'Sister Mary', ${frontDeskB.id})
      `,
      );

      const response = await get(`/patients/${patientId}/consents`, frontDeskBToken);
      expect(response.status).toBe(200);
      expect(
        response.body.map((consent: { status: string; witnessName: string | null }) => [
          consent.status,
          consent.witnessName,
        ]),
      ).toEqual([
        ['active', null],
        ['expired', 'Sister Mary'],
      ]);
    });

    it('revokes at once; only the grantee may, and only once', async () => {
      const elsewhere = await post(`/consents/${signedConsentId}/revoke`, frontDeskAToken, {
        reason: 'Not ours to revoke',
      });
      expect(elsewhere.status).toBe(404);

      const response = await post(`/consents/${signedConsentId}/revoke`, frontDeskBToken, {
        reason: 'Patient withdrew consent',
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'revoked',
        revokedBy: { id: frontDeskB.id },
        revocationReason: 'Patient withdrew consent',
      });

      const again = await post(`/consents/${signedConsentId}/revoke`, frontDeskBToken, {
        reason: 'Patient withdrew consent',
      });
      expect(again.status).toBe(409);

      const page = await timeline(tokenB);
      expect(shared(page.items)).toEqual([]);
    });
  });

  describe('emergency access', () => {
    it('needs a reason that says why, and lasts a day at most', async () => {
      const vague = await post(`/patients/${patientId}/break-glass`, tokenB, { reason: 'urgent' });
      expect(vague.status).toBe(400);

      const long = await post(`/patients/${patientId}/break-glass`, tokenB, {
        reason: EMERGENCY_REASON,
        hours: 48,
      });
      expect(long.status).toBe(400);
    });

    it('opens the whole record for a few hours, with the reason in the access log', async () => {
      const response = await post(`/patients/${patientId}/break-glass`, tokenB, {
        reason: EMERGENCY_REASON,
        hours: 2,
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        captureMethod: 'break_glass',
        status: 'active',
        emergencyReason: EMERGENCY_REASON,
        recordedBy: { id: clinicianB.id },
        review: null,
        patientNotifiedAt: null,
      });
      expect(response.body.dataCategories).toHaveLength(7);

      const hours =
        (Date.parse(response.body.expiresAt) - Date.parse(response.body.grantedAt)) / 3_600_000;
      expect(hours).toBeCloseTo(2, 3);
      breakGlassId = response.body.id;

      const page = await timeline(tokenB);
      expect(new Set(shared(page.items).map((item) => item.kind))).toEqual(
        new Set(['encounter', 'allergy', 'diagnosis', 'vitals', 'note', 'procedure']),
      );

      const [logged] = await owner<Array<{ reason: string | null }>>`
        SELECT break_glass_reason AS reason
          FROM access_log
         WHERE actor_id = ${clinicianB.id} AND resource_type = 'consent_artefact'
           AND resource_id = ${breakGlassId} AND action = 'create'
      `;
      expect(logged?.reason).toBe(EMERGENCY_REASON);

      const summary = await get(`/patients/${patientId}/summary`, tokenB);
      expect(summary.status).toBe(200);
      expect(summary.body.sharing.breakGlassUntil).toBe(response.body.expiresAt);
      expect(summary.body.allergies.allergies[0]).toMatchObject({
        substance: 'Penicillin',
        hospital: { id: hospitalA.id, isOwn: false },
      });
    });

    it('is kept brief and explained by the database itself', async () => {
      await expect(
        asSystem(
          (tx) => tx`
          INSERT INTO consent_artefact
            (patient_id, grantee_hospital_id, data_categories, expires_at, capture_method,
             emergency_reason, recorded_by_staff_id)
          VALUES (${patientId}, ${hospitalB.id}, '{notes}', now() + interval '48 hours',
                  'break_glass', ${EMERGENCY_REASON}, ${clinicianB.id})
        `,
        ),
      ).rejects.toThrow(/consent_artefact_break_glass_is_brief/);

      await expect(
        asSystem(
          (tx) => tx`
          INSERT INTO consent_artefact
            (patient_id, grantee_hospital_id, data_categories, expires_at, capture_method,
             recorded_by_staff_id)
          VALUES (${patientId}, ${hospitalB.id}, '{notes}', now() + interval '1 hour',
                  'break_glass', ${clinicianB.id})
        `,
        ),
      ).rejects.toThrow(/consent_artefact_break_glass_has_reason/);

      await expect(
        asSystem(
          (tx) => tx`
          UPDATE consent_artefact
             SET reviewed_at = now(), reviewed_by_staff_id = recorded_by_staff_id,
                 review_outcome = 'justified', review_note = 'I was right'
           WHERE id = ${breakGlassId}
        `,
        ),
      ).rejects.toThrow(/consent_artefact_review_consistent/);
    });

    it('queues it for the hospital’s review by MRN, never by the patient’s name', async () => {
      const queue = await get('/break-glass/reviews', adminBToken);

      expect(queue.status).toBe(200);
      expect(queue.body).toEqual([
        {
          id: breakGlassId,
          mrn: 'GPT-000001',
          reason: EMERGENCY_REASON,
          grantedAt: expect.any(String),
          expiresAt: expect.any(String),
          status: 'active',
          clinician: { id: clinicianB.id, name: expect.any(String) },
          patientNotified: false,
        },
      ]);
      expect(JSON.stringify(queue.body)).not.toContain('Kamala');

      const elsewhere = await get('/break-glass/reviews', adminAToken);
      expect(elsewhere.body).toEqual([]);
    });

    it('records the review once, and only for emergency access', async () => {
      const elsewhere = await post(`/consents/${breakGlassId}/review`, adminAToken, {
        outcome: 'unjustified',
        note: 'Not our hospital',
      });
      expect(elsewhere.status).toBe(404);

      const notEmergency = await post(`/consents/${signedConsentId}/review`, adminBToken, {
        outcome: 'justified',
        note: 'Nothing to review',
      });
      expect(notEmergency.status).toBe(400);

      const response = await post(`/consents/${breakGlassId}/review`, adminBToken, {
        outcome: 'justified',
        note: 'Patient arrived unconscious; history was needed',
      });
      expect(response.status).toBe(200);
      expect(response.body.review).toMatchObject({
        outcome: 'justified',
        reviewedBy: { id: adminB.id },
      });

      expect((await get('/break-glass/reviews', adminBToken)).body).toEqual([]);

      const again = await post(`/consents/${breakGlassId}/review`, adminBToken, {
        outcome: 'unjustified',
        note: 'Changing my mind',
      });
      expect(again.status).toBe(409);
    });
  });

  describe('summary card', () => {
    it('gathers the thirty-second view from the same reads as the full screens', async () => {
      const response = await get(`/patients/${patientId}/summary`, tokenA);

      expect(response.status).toBe(200);
      expect(
        response.body.allergies.allergies.map((a: { substance: string }) => a.substance),
      ).toEqual(['Penicillin']);
      expect(JSON.stringify(response.body.problems)).toContain('DEMO-NAM-001');
      expect(response.body.latestVitals).not.toBeNull();
      expect(response.body.recentEncounters).toHaveLength(1);
      expect(response.body.sharing).toEqual({
        categories: [],
        expiresAt: null,
        breakGlassUntil: null,
      });
    });

    it('is refused for a patient the hospital does not know', async () => {
      const response = await get(`/patients/${patientOnlyAtA}/summary`, tokenB);
      expect(response.status).toBe(404);
    });
  });

  describe('coding review', () => {
    let elementId: string;

    it('flags a diagnosis whose translation rests on a mapping since retired', async () => {
      expect((await get('/coding-reviews', tokenA)).body).toEqual([]);

      const [element] = await owner<Array<{ id: string }>>`
        SELECT e.id
          FROM concept_map_element e
          JOIN concept_map m ON m.id = e.concept_map_id
          JOIN code_system t ON t.id = m.target_system_id
         WHERE t.key = 'icd11-tm2' AND e.source_code = 'DEMO-NAM-001' AND e.status = 'approved'
      `;
      elementId = element!.id;

      await owner`UPDATE concept_map_element SET status = 'retired' WHERE id = ${elementId}`;

      const response = await get('/coding-reviews', tokenA);
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        conditionId: diagnosisId,
        patient: { id: patientId, name: 'Kamala Timeline', mrn: expect.stringMatching(/^SPT-/) },
        primary: { system: 'namaste', code: 'DEMO-NAM-001', role: 'primary' },
        flagged: { role: 'translated', mappingStatus: 'retired', conceptMapElementId: elementId },
        suggestion: { primary: { code: 'DEMO-NAM-001' }, translated: null },
      });

      // Another hospital's coding is theirs to review, even when it can read the diagnosis.
      expect((await get('/coding-reviews', tokenB)).body).toEqual([]);
    });

    it('keeps the code as recorded once a clinician says why', async () => {
      const elsewhere = await post(`/coding-reviews/${diagnosisId}/acknowledge`, tokenB, {
        conceptMapElementId: elementId,
        note: 'Not our diagnosis',
      });
      expect(elsewhere.status).toBe(404);

      const wrongElement = await post(`/coding-reviews/${diagnosisId}/acknowledge`, tokenA, {
        conceptMapElementId: '00000000-0000-4000-8000-000000000000',
        note: 'No such mapping',
      });
      expect(wrongElement.status).toBe(404);

      const response = await post(`/coding-reviews/${diagnosisId}/acknowledge`, tokenA, {
        conceptMapElementId: elementId,
        note: 'The TM2 code still describes the presentation',
      });
      expect(response.status).toBe(201);
      expect((await get('/coding-reviews', tokenA)).body).toEqual([]);

      const again = await post(`/coding-reviews/${diagnosisId}/acknowledge`, tokenA, {
        conceptMapElementId: elementId,
        note: 'Once more',
      });
      expect(again.status).toBe(409);
    });
  });
});
