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
 * Prescriptions, current medications, and the allergy check at prescribing.
 *
 * The scenario the product exists for, in miniature: an Ayurvedic hospital
 * prescribes a four-month formulation and records a penicillin allergy; an
 * allopathic hospital then prescribes. Without shared allergies it cannot
 * know; with them, the prescription is stopped at the point of writing.
 */

/** Today in India Standard Time, as YYYY-MM-DD. */
const istToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const addDays = (isoDate: string, days: number): string => {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

describe('prescriptions', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalA: { id: string; name: string };
  let hospitalB: { id: string };
  let clinicianA: SeededStaff;
  let frontDeskB: SeededStaff;
  let tokenA: string;
  let tokenB: string;

  let patientId: string;
  let encounterA: string;
  let encounterB: string;
  let avipattikarId: string;

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

  async function grantConsent(categories: string): Promise<string> {
    const [row] = await asSystem(
      (tx) => tx<Array<{ id: string }>>`
        INSERT INTO consent_artefact
          (patient_id, grantee_hospital_id, data_categories, expires_at, capture_method, recorded_by_staff_id)
        VALUES (${patientId}, ${hospitalB.id}, ${categories}::clinical_data_category[],
                now() + interval '30 days', 'signed_form', ${frontDeskB.id})
        RETURNING id
      `,
    );

    return row!.id;
  }

  async function latestConsentAudit(resourceType: string, actorId: string) {
    const [row] = await owner<Array<{ consent: string | null }>>`
      SELECT consent_artefact_id AS consent
        FROM access_log
       WHERE actor_id = ${actorId} AND resource_type = ${resourceType} AND action = 'read'
    ORDER BY at DESC
       LIMIT 1
    `;

    return row?.consent ?? null;
  }

  const penicillinFor = (encounterId: string, extra: Record<string, unknown> = {}) => ({
    encounterId,
    medicineName: 'Penicillin V',
    frequency: 'four times daily',
    route: 'oral',
    ...extra,
  });

  let clinicianBId: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const a = await seedHospital({ name: 'Sanjeevani Prescription Test', mrnPrefix: 'SPT' });
    const b = await seedHospital({
      name: 'City General Prescription Test',
      mrnPrefix: 'GPT',
      facilityType: 'allopathic',
    });

    hospitalA = a.hospital;
    hospitalB = b.hospital;
    clinicianA = a.staff.clinician as SeededStaff;
    frontDeskB = b.staff.frontDesk as SeededStaff;
    clinicianBId = (b.staff.clinician as SeededStaff).id;

    tokenA = await signIn(ctx, clinicianA);
    tokenB = await signIn(ctx, b.staff.clinician as SeededStaff);

    const registered = await post(
      '/patients',
      await signIn(ctx, a.staff.frontDesk as SeededStaff),
      {
        name: 'Kamala Prescription',
        gender: 'female',
        dateOfBirth: '1970-01-30',
        phone: '9820066661',
      },
    );
    patientId = registered.body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    await asSystem(
      (tx) => tx`
        INSERT INTO patient_hospital_link (patient_id, hospital_id, mrn)
        VALUES (${patientId}, ${hospitalB.id}, 'GPT-000001')
      `,
    );

    encounterA = (await post('/encounters', tokenA, { patientId })).body.id;
    encounterB = (await post('/encounters', tokenB, { patientId, systemOfMedicine: 'allopathy' }))
      .body.id;
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  describe('prescribing', () => {
    it('records an Ayurvedic formulation in structured fields', async () => {
      const startDate = addDays(istToday(), -30);

      const response = await post('/prescriptions', tokenA, {
        encounterId: encounterA,
        medicineName: 'Avipattikar churna',
        form: 'churna',
        dose: { quantity: 5, unit: 'g' },
        frequency: '1-0-1',
        route: 'oral',
        duration: { value: 120, unit: 'days' },
        startDate,
        vehicle: 'Warm water',
        foodTiming: 'before_food',
        instructions: 'Avoid spicy food during the course',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        patientId,
        encounterId: encounterA,
        hospital: { id: hospitalA.id, isOwn: true },
        // Taken from the encounter when not given.
        systemOfMedicine: 'ayurveda',
        medicineName: 'Avipattikar churna',
        form: 'churna',
        strength: null,
        dose: { quantity: 5, unit: 'g' },
        frequency: '1-0-1',
        route: 'oral',
        duration: { value: 120, unit: 'days' },
        startDate,
        endDate: addDays(startDate, 119),
        vehicle: 'Warm water',
        foodTiming: 'before_food',
        status: 'active',
        endedAt: null,
        allergyOverrideReason: null,
        prescriber: { id: clinicianA.id, name: expect.any(String) },
        allergyCheck: { matches: [], sharedFromOtherHospitals: false },
      });
      expect(response.body.allergyCheck.limitation).toMatch(/exact name/i);

      avipattikarId = response.body.id;
    });

    it('works out the last day of a course measured in months', async () => {
      const response = await post('/prescriptions', tokenA, {
        encounterId: encounterA,
        medicineName: 'Kamdudha tablets',
        frequency: '2-0-2',
        route: 'oral',
        duration: { value: 1, unit: 'months' },
        startDate: '2025-01-15',
      });

      expect(response.status).toBe(201);
      expect(response.body.endDate).toBe('2025-02-14');
    });

    it('leaves an open-ended prescription without an end date', async () => {
      const response = await post('/prescriptions', tokenA, {
        encounterId: encounterA,
        medicineName: 'Triphala churna',
        frequency: 'at bedtime',
        route: 'oral',
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ duration: null, dose: null, endDate: null });
      expect(response.body.startDate).toBe(istToday());
    });

    it('refuses a dose without a unit, and a zero-length course', async () => {
      const noUnit = await post('/prescriptions', tokenA, {
        encounterId: encounterA,
        medicineName: 'Something',
        frequency: '1-0-1',
        route: 'oral',
        dose: { quantity: 2 },
      });
      expect(noUnit.status).toBe(400);

      const zero = await post('/prescriptions', tokenA, {
        encounterId: encounterA,
        medicineName: 'Something',
        frequency: '1-0-1',
        route: 'oral',
        duration: { value: 0, unit: 'days' },
      });
      expect(zero.status).toBe(400);
    });

    it('refuses a cancelled encounter and another hospital’s encounter', async () => {
      const opened = await post('/encounters', tokenA, { patientId });
      await post(`/encounters/${opened.body.id}/cancel`, tokenA, { reason: 'Opened in error' });

      const cancelled = await post('/prescriptions', tokenA, {
        encounterId: opened.body.id,
        medicineName: 'Something',
        frequency: '1-0-1',
        route: 'oral',
      });
      expect(cancelled.status).toBe(409);

      const foreign = await post('/prescriptions', tokenB, {
        encounterId: encounterA,
        medicineName: 'Something',
        frequency: '1-0-1',
        route: 'oral',
      });
      expect(foreign.status).toBe(404);
    });
  });

  describe('allergy check at prescribing', () => {
    beforeAll(async () => {
      await post('/allergies', tokenA, {
        patientId,
        substance: 'Penicillin V',
        category: 'medication',
        criticality: 'high',
        reaction: 'Anaphylaxis',
      });

      await post('/allergies', tokenA, {
        patientId,
        substance: 'Milk',
        category: 'food',
        criticality: 'low',
      });
    });

    it('stops a prescription whose name matches, ignoring case and spacing', async () => {
      const response = await post(
        '/prescriptions',
        tokenA,
        penicillinFor(encounterA, { medicineName: '  penicillin   v ' }),
      );

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'ALLERGY_MATCH',
        matches: [
          {
            substance: 'Penicillin V',
            criticality: 'high',
            reaction: 'Anaphylaxis',
            matchedField: 'medicine',
            hospital: { id: hospitalA.id, isOwn: true },
          },
        ],
      });

      const written = await get(`/encounters/${encounterA}/prescriptions`, tokenA);
      expect(
        written.body.some((row: { medicineName: string }) =>
          row.medicineName.toLowerCase().includes('penicillin'),
        ),
        'a refused prescription must not be written',
      ).toBe(false);
    });

    it('checks the vehicle a medicine is taken with', async () => {
      const response = await post('/prescriptions', tokenA, {
        encounterId: encounterA,
        medicineName: 'Ashwattha kshira',
        frequency: 'once daily',
        route: 'oral',
        vehicle: 'milk',
      });

      expect(response.status).toBe(409);
      expect(response.body.matches[0]).toMatchObject({
        substance: 'Milk',
        matchedField: 'vehicle',
      });
    });

    it('does not flag a related medicine: the check is by exact name only', async () => {
      const response = await post(
        '/prescriptions',
        tokenA,
        penicillinFor(encounterA, { medicineName: 'Amoxicillin' }),
      );

      expect(response.status).toBe(201);
      expect(response.body.allergyCheck.matches).toEqual([]);
    });

    it('records a deliberate override with its reason', async () => {
      const response = await post(
        '/prescriptions',
        tokenA,
        penicillinFor(encounterA, {
          allergyOverride: { reason: 'Desensitised under supervision last month' },
        }),
      );

      expect(response.status).toBe(201);
      expect(response.body.allergyOverrideReason).toBe('Desensitised under supervision last month');
      expect(response.body.allergyCheck.matches).toHaveLength(1);
    });

    it('cannot see another hospital’s allergy without consent', async () => {
      const response = await post('/prescriptions', tokenB, penicillinFor(encounterB));

      expect(response.status).toBe(201);
      expect(response.body.allergyCheck).toMatchObject({
        matches: [],
        sharedFromOtherHospitals: false,
      });
      expect(response.body.systemOfMedicine).toBe('allopathy');
    });

    it('catches the Ayurvedic hospital’s allergy once allergies are shared, and audits it', async () => {
      const consentId = await grantConsent('{allergies}');

      const response = await post(
        '/prescriptions',
        tokenB,
        penicillinFor(encounterB, { medicineName: 'penicillin v' }),
      );

      expect(response.status).toBe(409);
      expect(response.body.matches[0]).toMatchObject({
        substance: 'Penicillin V',
        hospital: { id: hospitalA.id, name: hospitalA.name, isOwn: false },
      });

      expect(await latestConsentAudit('allergy_intolerance', clinicianBId)).toBe(consentId);
    });
  });

  describe('current medications', () => {
    it('shows only the hospital’s own without medication consent', async () => {
      const response = await get(`/patients/${patientId}/medications`, tokenB);

      expect(response.status).toBe(200);
      expect(response.body.sharedFromOtherHospitals).toBe(false);
      expect(
        response.body.medications.every(
          (row: { hospital: { isOwn: boolean } }) => row.hospital.isOwn,
        ),
      ).toBe(true);
    });

    it('shows both hospitals’ treatment under consent, grouped by system of medicine', async () => {
      const consentId = await grantConsent('{medications}');

      const response = await get(`/patients/${patientId}/medications`, tokenB);

      expect(response.status).toBe(200);
      expect(response.body.sharedFromOtherHospitals).toBe(true);

      const names = response.body.medications.map(
        (row: { medicineName: string }) => row.medicineName,
      );

      expect(names).toContain('Avipattikar churna');
      expect(names).toContain('Triphala churna');
      // A course that ended in February 2025 is not current.
      expect(names).not.toContain('Kamdudha tablets');

      const avipattikar = response.body.medications.find(
        (row: { id: string }) => row.id === avipattikarId,
      );
      expect(avipattikar).toMatchObject({
        systemOfMedicine: 'ayurveda',
        hospital: { id: hospitalA.id, isOwn: false },
        prescriber: { id: clinicianA.id, name: null },
      });

      const systems = response.body.medications.map(
        (row: { systemOfMedicine: string }) => row.systemOfMedicine,
      );
      // Grouped, not alphabetical: each system of medicine forms one unbroken
      // block, in the order the systems are declared — traditional first.
      const blocks = systems.filter(
        (system: string, index: number) => index === 0 || systems[index - 1] !== system,
      );
      expect(blocks).toEqual([...new Set(blocks)]);
      expect(blocks).toEqual(['ayurveda', 'allopathy']);

      expect(await latestConsentAudit('medication_request', clinicianBId)).toBe(consentId);
    });
  });

  describe('stopping', () => {
    it('lets only the prescribing hospital stop a medicine', async () => {
      const response = await post(`/prescriptions/${avipattikarId}/stop`, tokenB, {
        reason: 'Not ours to stop',
      });

      expect(response.status).toBe(403);
    });

    it('requires a reason', async () => {
      const response = await post(`/prescriptions/${avipattikarId}/stop`, tokenA, {});
      expect(response.status).toBe(400);
    });

    it('stops a medicine once, and it leaves the current list', async () => {
      const stopped = await post(`/prescriptions/${avipattikarId}/stop`, tokenA, {
        reason: 'Symptoms resolved',
      });

      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ status: 'stopped', endReason: 'Symptoms resolved' });
      expect(stopped.body.endedAt).not.toBeNull();

      const again = await post(`/prescriptions/${avipattikarId}/stop`, tokenA, {
        reason: 'Symptoms resolved',
      });
      expect(again.status).toBe(409);

      const current = await get(`/patients/${patientId}/medications`, tokenA);
      expect(current.body.medications.map((row: { id: string }) => row.id)).not.toContain(
        avipattikarId,
      );

      // Still on the encounter's record, marked stopped.
      const onEncounter = await get(`/encounters/${encounterA}/prescriptions`, tokenA);
      expect(onEncounter.body.find((row: { id: string }) => row.id === avipattikarId)?.status).toBe(
        'stopped',
      );
    });
  });
});
