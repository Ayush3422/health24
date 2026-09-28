import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  MOCK_GATEWAY_CODE,
  MockGatewayServer,
} from '../src/modules/abdm/gateway/mock-gateway';
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

/**
 * A consent granted in the patient's ABHA app, landing in the consent model
 * this system already has (sp8-plan.md, Phase 4, Decision Y1).
 *
 * The test that matters is the last group. Everything before it checks that
 * the artefact is written correctly; that group checks what it actually
 * *reveals*, by setting the assembly context on an unprivileged connection
 * and reading the clinical tables through the same policies a data request
 * will. A consent for medicines must show medicines, and must show no
 * diagnosis, no note, and nothing dated a day outside the range — whatever
 * the code that reads it believes it is doing.
 */
describe('ABDM consent', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let app: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let gateway: MockGatewayServer;
  let hospital: { id: string };
  let other: { id: string };
  let frontDesk: SeededStaff;
  let clinician: SeededStaff;
  let token: string;
  let clinicianToken: string;

  const HIP_ID = 'HFR-CONSENT-0001';
  const CALLBACK_SECRET = 'a-shared-secret-for-callbacks';
  const ABHA = 'kamala.nair@abdm';
  const HIU = { id: 'shanti-hiu@cm', name: 'Shanti Allopathic (HIU)' };

  let patientId: string;
  let encounterId: string;

  const before: Record<string, string | undefined> = {};

  const post = (path: string, body: Record<string, unknown> = {}, as = token) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${as}`).send(body);

  const today = new Date();
  const isoDay = (offsetDays: number): string => {
    const at = new Date(today);
    at.setUTCDate(at.getUTCDate() + offsetDays);
    return at.toISOString();
  };

  /** Sends the consent manager's notification, and hands back the status. */
  async function notify(
    overrides: Record<string, unknown> = {},
    detail: Record<string, unknown> = {},
    options: { hipId?: string } = {},
  ): Promise<{ status: number }> {
    return gateway.ask('consent.notify', options.hipId ?? HIP_ID, {
      notification: {
        status: 'GRANTED',
        consentId: `abdm-consent-${String(Math.random()).slice(2)}`,
        consentDetail: {
          hiu: HIU,
          careContexts: [{ careContextReference: encounterId }],
          hiTypes: ['Prescription'],
          permission: {
            dateRange: { from: isoDay(-30), to: isoDay(1) },
            dataEraseAt: isoDay(30),
          },
          ...detail,
        },
        ...overrides,
      },
    });
  }

  /** Reads a table as the application role would, inside an assembly context. */
  async function asAssembly<T>(consentArtefactId: string, table: string): Promise<T[]> {
    return app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_abdm_consent_id', ${consentArtefactId}, true)`;
      return tx.unsafe(`SELECT id FROM "${table}"`);
    }) as Promise<T[]>;
  }

  async function artefactFor(consentId: string): Promise<{ id: string; data_categories: string[] }> {
    const [row] = await owner<Array<{ id: string; data_categories: string[] }>>`
      SELECT id, data_categories::text[] AS data_categories
        FROM consent_artefact WHERE abdm_consent_id = ${consentId}
    `;

    if (!row) throw new Error(`No artefact recorded for ${consentId}`);
    return row;
  }

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();

    const seeded = await seedHospital({ name: 'Sanjeevani Ayurveda', mrnPrefix: 'SJT' });
    hospital = seeded.hospital;
    frontDesk = seeded.staff.frontDesk!;
    clinician = seeded.staff.clinician!;

    const elsewhere = await seedHospital({ name: 'Shanti Allopathic', mrnPrefix: 'SHA' });
    other = elsewhere.hospital;

    gateway = new MockGatewayServer({
      clientId: 'health24-under-test',
      clientSecret: 'not-a-real-client-secret',
      callbackSecret: CALLBACK_SECRET,
    });

    await gateway.start();
    closers.push(() => gateway.stop());

    for (const [key, value] of Object.entries({
      ABDM_MODE: 'gateway',
      ABDM_GATEWAY_URL: gateway.url,
      ABDM_CLIENT_ID: 'health24-under-test',
      ABDM_CLIENT_SECRET: 'not-a-real-client-secret',
      ABDM_HIP_ID: HIP_ID,
      ABDM_CM_ID: 'sbx',
      ABDM_CALLBACK_SECRET: CALLBACK_SECRET,
      ABDM_CALL_TIMEOUT_MS: '5000',
    })) {
      before[key] = process.env[key];
      process.env[key] = value;
    }

    ctx = await createTestApp();
    closers.push(ctx.close);

    await ctx.app.listen(0);
    const address = ctx.app.getHttpServer().address() as AddressInfo;
    gateway.callbackBaseUrl = `http://127.0.0.1:${String(address.port)}`;

    token = await signIn(ctx, frontDesk);
    clinicianToken = await signIn(ctx, clinician);

    const ownerConnection = testDb();
    owner = ownerConnection.client;
    closers.push(ownerConnection.close);

    const appConnection = appRoleDb();
    app = appConnection.client;
    closers.push(appConnection.close);

    await owner`UPDATE hospital SET hfr_id = ${HIP_ID} WHERE id = ${hospital.id}`;

    const registered = await post('/patients', {
      name: 'Kamala Nair',
      gender: 'female',
      dateOfBirth: '1986-07-19',
      phone: '+919812345672',
      forceCreate: true,
    });

    patientId = (registered.body as { patient: { id: string } }).patient.id;

    await owner`
      SELECT app.record_abha_verification(
        ${patientId}::uuid, NULL, ${ABHA}, 'mobile_otp'::abha_verification_method, NULL
      )
    `;

    const encounter = await post('/encounters', { patientId }, clinicianToken);
    encounterId = (encounter.body as { id: string }).id;

    // One of each kind, all dated today, so the only thing separating them in
    // the tests below is the consent.
    await post(
      '/diagnoses',
      { encounterId, code: 'DEMO-NAM-001', clinicalStatus: 'active' },
      clinicianToken,
    );

    await post(
      '/prescriptions',
      {
        encounterId,
        medicineName: 'Avipattikar churna',
        form: 'churna',
        dose: { quantity: 5, unit: 'g' },
        frequency: '1-0-1',
        route: 'oral',
        duration: { value: 30, unit: 'days' },
        startDate: new Date().toISOString().slice(0, 10),
      },
      clinicianToken,
    );

    await post(
      '/notes',
      { encounterId, template: 'general', sections: { subjective: 'Burning after meals' } },
      clinicianToken,
    );

    // The visit is on the national network; without that, no consent over it
    // can be honoured at all.
    const offered = await post(`/patients/${patientId}/care-contexts/link`, {
      encounterIds: [encounterId],
    });

    await post(`/patients/${patientId}/care-contexts/link/confirm`, {
      linkRequestId: (offered.body as { linkRequestId: string }).linkRequestId,
      code: MOCK_GATEWAY_CODE,
    });
  }, 120_000);

  afterAll(async () => {
    for (const close of closers) await close();

    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('what the notification becomes', () => {
    it('writes one artefact, in the table every other consent lives in', async () => {
      const consentId = 'abdm-consent-written';
      expect((await notify({ consentId })).status).toBe(202);

      const [row] = await owner<
        Array<{
          source: string;
          capture_method: string;
          grantee_hospital_id: string | null;
          grantee_abdm_hiu_id: string;
          hip_hospital_id: string;
          data_categories: string[];
          recorded_by_staff_id: string | null;
          recorded_by_patient_account_id: string | null;
        }>
      >`
        SELECT source::text, capture_method::text, grantee_hospital_id, grantee_abdm_hiu_id,
               hip_hospital_id, data_categories::text[] AS data_categories,
               recorded_by_staff_id, recorded_by_patient_account_id
          FROM consent_artefact WHERE abdm_consent_id = ${consentId}
      `;

      expect(row).toMatchObject({
        source: 'abdm',
        capture_method: 'abdm',
        // No hospital is the grantee, which is why `app.consent_permits`
        // could never let a hospital read anything under it.
        grantee_hospital_id: null,
        grantee_abdm_hiu_id: HIU.id,
        hip_hospital_id: hospital.id,
        // Nobody here recorded it; the database refuses a row claiming so.
        recorded_by_staff_id: null,
        recorded_by_patient_account_id: null,
      });

      expect(row?.data_categories).toEqual(['medications']);
    });

    it('is written once however many times it is delivered', async () => {
      const consentId = 'abdm-consent-redelivered';

      expect((await notify({ consentId })).status).toBe(202);
      expect((await notify({ consentId })).status).toBe(202);
      expect((await notify({ consentId })).status).toBe(202);

      const [row] = await owner<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM consent_artefact WHERE abdm_consent_id = ${consentId}
      `;

      expect(row?.count).toBe(1);
    });

    it('records what it could not grant rather than dropping it', async () => {
      const consentId = 'abdm-consent-partly-mapped';

      expect(
        (await notify({ consentId }, { hiTypes: ['Prescription', 'ImmunizationRecord'] })).status,
      ).toBe(202);

      const [row] = await owner<Array<{ data_categories: string[]; abdm_unmapped_types: string[] }>>`
        SELECT data_categories::text[] AS data_categories,
               abdm_unmapped_types
          FROM consent_artefact WHERE abdm_consent_id = ${consentId}
      `;

      expect(row?.data_categories).toEqual(['medications']);
      expect(row?.abdm_unmapped_types).toEqual(['ImmunizationRecord']);
    });
  });

  describe('what it refuses', () => {
    it('refuses a consent over a visit this facility never shared', async () => {
      const response = await notify(
        { consentId: 'abdm-consent-unlinked' },
        { careContexts: [{ careContextReference: '01a0d7c3-a410-7273-864b-ad9f69444495' }] },
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('refuses a consent that asks only for what this system does not hold', async () => {
      const response = await notify(
        { consentId: 'abdm-consent-nothing' },
        { hiTypes: ['ImmunizationRecord'] },
      );

      // Better than storing a consent that grants nothing: the patient would
      // believe their records were flowing.
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('refuses a consent with no end date', async () => {
      const response = await notify(
        { consentId: 'abdm-consent-forever' },
        { permission: { dateRange: { from: isoDay(-30), to: isoDay(1) } } },
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('refuses to answer for a facility this deployment does not know', async () => {
      const response = await notify(
        { consentId: 'abdm-consent-elsewhere' },
        {},
        { hipId: 'HFR-SOMEBODY-ELSE' },
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('what it actually reveals', () => {
    it('shows the medicines it named, and nothing else of the record', async () => {
      const consentId = 'abdm-consent-medicines-only';
      await notify({ consentId });

      const artefact = await artefactFor(consentId);

      expect(await asAssembly(artefact.id, 'medication_request')).toHaveLength(1);
      // Not a category more.
      expect(await asAssembly(artefact.id, 'condition')).toHaveLength(0);
      expect(await asAssembly(artefact.id, 'encounter')).toHaveLength(0);
      expect(await asAssembly(artefact.id, 'clinical_note')).toHaveLength(0);
    });

    it('shows nothing at all a day outside the range it named', async () => {
      const consentId = 'abdm-consent-yesterday';

      await notify(
        { consentId },
        {
          // Wide in categories, and closed the day before the record exists.
          hiTypes: ['OPConsultation'],
          permission: {
            dateRange: { from: isoDay(-30), to: isoDay(-1) },
            dataEraseAt: isoDay(30),
          },
        },
      );

      const artefact = await artefactFor(consentId);
      expect(artefact.data_categories).toContain('diagnoses');

      expect(await asAssembly(artefact.id, 'condition')).toHaveLength(0);
      expect(await asAssembly(artefact.id, 'medication_request')).toHaveLength(0);
    });

    /**
     * The rule SP5 set for the patient's own export, holding here: whether a
     * doctor's free text belongs in a bundle is a clinical reviewer's
     * decision, and no health information type may make it for them.
     */
    it('never shows a clinician’s note, however wide the consent', async () => {
      const consentId = 'abdm-consent-everything';

      await notify(
        { consentId },
        {
          hiTypes: [
            'OPConsultation',
            'DischargeSummary',
            'Prescription',
            'DiagnosticReport',
            'HealthDocumentRecord',
            'WellnessRecord',
          ],
          permission: {
            dateRange: { from: isoDay(-30), to: isoDay(1) },
            dataEraseAt: isoDay(30),
          },
        },
      );

      const artefact = await artefactFor(consentId);

      expect(artefact.data_categories).not.toContain('notes');
      expect(await asAssembly(artefact.id, 'condition')).toHaveLength(1);
      expect(await asAssembly(artefact.id, 'clinical_note')).toHaveLength(0);
    });

    it('reveals nothing to a hospital, however the artefact is read', async () => {
      const consentId = 'abdm-consent-not-for-hospitals';
      await notify({ consentId });

      // The other hospital has no consent of its own and never will get one
      // from this: an ABDM artefact names no grantee hospital at all.
      const rows = await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_hospital_id', ${other.id}, true)`;
        return tx`SELECT id FROM medication_request`;
      });

      expect(rows).toHaveLength(0);
    });
  });

  describe('when it ends', () => {
    it('stops revealing anything the moment the consent manager revokes it', async () => {
      const consentId = 'abdm-consent-revoked';
      await notify({ consentId });

      const artefact = await artefactFor(consentId);
      expect(await asAssembly(artefact.id, 'medication_request')).toHaveLength(1);

      expect((await notify({ consentId, status: 'REVOKED' })).status).toBe(202);

      const [row] = await owner<Array<{ status: string; revocation_reason: string }>>`
        SELECT status::text, revocation_reason FROM consent_artefact WHERE id = ${artefact.id}
      `;

      expect(row?.status).toBe('revoked');
      expect(row?.revocation_reason).toMatch(/Revoked at the consent manager/);
      expect(await asAssembly(artefact.id, 'medication_request')).toHaveLength(0);
    });

    it('treats an expiry at the consent manager the same way', async () => {
      const consentId = 'abdm-consent-expired';
      await notify({ consentId });

      const artefact = await artefactFor(consentId);
      expect((await notify({ consentId, status: 'EXPIRED' })).status).toBe(202);

      const [row] = await owner<Array<{ status: string; revocation_reason: string }>>`
        SELECT status::text, revocation_reason FROM consent_artefact WHERE id = ${artefact.id}
      `;

      expect(row?.status).toBe('revoked');
      expect(row?.revocation_reason).toMatch(/Expired at the consent manager/);
    });

    it('is revocable by the patient here, whatever the consent manager still says', async () => {
      const consentId = 'abdm-consent-patient-revoked';
      await notify({ consentId });

      const artefact = await artefactFor(consentId);

      // As the patient, on the unprivileged connection: SP5's own policy
      // lets a patient end any consent over their record that is not
      // emergency access, and an ABDM artefact is no exception.
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.current_patient_id', ${patientId}, true)`;
        return tx`
          UPDATE consent_artefact
             SET status = 'revoked', revoked_at = now(),
                 revocation_reason = 'The patient ended it here'
           WHERE id = ${artefact.id}
        `;
      });

      expect(await asAssembly(artefact.id, 'medication_request')).toHaveLength(0);
    });

    it('is on the patient’s trail, both when it arrives and when it ends', async () => {
      const rows = await owner<Array<{ action: string }>>`
        SELECT action::text FROM access_log
         WHERE patient_id = ${patientId}
           AND resource_type = 'consent_artefact'
           AND actor_type = 'system'
      `;

      const actions = rows.map((row) => row.action);
      expect(actions).toContain('create');
      expect(actions).toContain('update');
    });
  });
});
