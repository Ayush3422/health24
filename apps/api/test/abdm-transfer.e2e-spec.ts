import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  MOCK_GATEWAY_CODE,
  MockGatewayServer,
  type DataPush,
} from '../src/modules/abdm/gateway/mock-gateway';
import { decryptAsRequester, generateRequesterKeys } from '../src/modules/abdm/transfer/fidelius';
import { TransferService } from '../src/modules/abdm/transfer/transfer.service';
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

/**
 * Answering a request for a patient's records (sp8-plan.md, Phase 5).
 *
 * The suite plays the requester: it generates the key pair ABDM would send,
 * receives the pushes at an endpoint of its own, and **decrypts them**. So
 * what is asserted is not that this system called the right functions — it is
 * what a requester actually receives, which is the only thing that matters.
 *
 * The last test is the one this phase exists to be able to pass: a consent
 * withdrawn between two pushes stops the second, and the row left behind says
 * that some of it went and the rest did not.
 */
describe('answering an ABDM data request', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let gateway: MockGatewayServer;
  let hospital: { id: string };
  let frontDesk: SeededStaff;
  let clinician: SeededStaff;
  let token: string;
  let clinicianToken: string;

  const HIP_ID = 'HFR-TRANSFER-0001';
  const CALLBACK_SECRET = 'a-shared-secret-for-callbacks';
  const ABHA = 'kamala.nair@abdm';

  let patientId: string;
  let firstVisit: string;
  let secondVisit: string;

  const before: Record<string, string | undefined> = {};

  const post = (path: string, body: Record<string, unknown> = {}, as = token) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${as}`).send(body);

  const isoDay = (offsetDays: number): string => {
    const at = new Date();
    at.setUTCDate(at.getUTCDate() + offsetDays);
    return at.toISOString();
  };

  async function openVisit(): Promise<string> {
    const response = await post('/encounters', { patientId }, clinicianToken);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { id: string }).id;
  }

  async function linkVisit(encounterId: string): Promise<void> {
    const offered = await post(`/patients/${patientId}/care-contexts/link`, {
      encounterIds: [encounterId],
    });

    const confirmed = await post(`/patients/${patientId}/care-contexts/link/confirm`, {
      linkRequestId: (offered.body as { linkRequestId: string }).linkRequestId,
      code: MOCK_GATEWAY_CODE,
    });

    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
  }

  /** A consent over the given visits, as the consent manager would notify it. */
  async function grantConsent(
    consentId: string,
    careContexts: string[],
    hiTypes = ['Prescription', 'OPConsultation'],
  ): Promise<string> {
    const answered = await gateway.ask('consent.notify', HIP_ID, {
      notification: {
        status: 'GRANTED',
        consentId,
        consentDetail: {
          hiu: { id: 'shanti-hiu@cm', name: 'Shanti Allopathic (HIU)' },
          careContexts: careContexts.map((reference) => ({ careContextReference: reference })),
          hiTypes,
          permission: {
            dateRange: { from: isoDay(-30), to: isoDay(1) },
            dataEraseAt: isoDay(30),
          },
        },
      },
    });

    expect(answered.status).toBe(202);

    const [row] = await owner<Array<{ id: string }>>`
      SELECT id FROM consent_artefact WHERE abdm_consent_id = ${consentId}
    `;

    return row!.id;
  }

  /** Sends the request the requester would send, and returns its transfer row. */
  async function requestData(
    consentId: string,
    transactionId: string,
  ): Promise<{ dataRequestId: string; requester: ReturnType<typeof generateRequesterKeys> }> {
    const requester = generateRequesterKeys();

    const answered = await gateway.ask('health-information.request', HIP_ID, {
      transactionId,
      hiRequest: {
        consent: { id: consentId },
        dataPushUrl: gateway.dataPushUrl,
        keyMaterial: {
          cryptoAlg: 'ECDH',
          curve: 'Curve25519',
          dhPublicKey: { keyValue: requester.material.publicKey },
          nonce: requester.material.nonce,
        },
      },
    });

    expect(answered.status, `data request refused with ${String(answered.status)}`).toBe(202);

    const [row] = await owner<Array<{ id: string }>>`
      SELECT id FROM abdm_data_request WHERE abdm_transaction_id = ${transactionId}
    `;

    return { dataRequestId: row!.id, requester };
  }

  /** What the requester can read out of a push. */
  function open(push: DataPush, requester: ReturnType<typeof generateRequesterKeys>): {
    bundle: Record<string, unknown>;
    resourceTypes: string[];
  } {
    const bundle = decryptAsRequester(
      { publicKey: push.keyMaterial.dhPublicKey.keyValue, nonce: push.keyMaterial.nonce },
      requester.privateKey,
      requester.material.nonce,
      push.entries[0]!.content,
    ) as { entry: Array<{ resource: { resourceType: string } }> };

    return {
      bundle: bundle as unknown as Record<string, unknown>,
      resourceTypes: bundle.entry.map((entry) => entry.resource.resourceType),
    };
  }

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();

    const seeded = await seedHospital({ name: 'Sanjeevani Ayurveda', mrnPrefix: 'SJT' });
    hospital = seeded.hospital;
    frontDesk = seeded.staff.frontDesk!;
    clinician = seeded.staff.clinician!;

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

    await owner`UPDATE hospital SET hfr_id = ${HIP_ID} WHERE id = ${hospital.id}`;

    const registered = await post('/patients', {
      name: 'Kamala Nair',
      gender: 'female',
      dateOfBirth: '1986-07-19',
      phone: '+919812345673',
      forceCreate: true,
    });

    patientId = (registered.body as { patient: { id: string } }).patient.id;

    await owner`
      SELECT app.record_abha_verification(
        ${patientId}::uuid, NULL, ${ABHA}, 'mobile_otp'::abha_verification_method, NULL
      )
    `;

    firstVisit = await openVisit();
    secondVisit = await openVisit();

    for (const visit of [firstVisit, secondVisit]) {
      await post(
        '/diagnoses',
        { encounterId: visit, code: 'DEMO-NAM-001', clinicalStatus: 'active' },
        clinicianToken,
      );

      await post(
        '/prescriptions',
        {
          encounterId: visit,
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
        { encounterId: visit, template: 'general', sections: { subjective: 'Burning after meals' } },
        clinicianToken,
      );

      await linkVisit(visit);
    }
  }, 180_000);

  afterAll(async () => {
    for (const close of closers) await close();

    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('what the requester receives', () => {
    it('is a document bundle it can decrypt, holding what the consent allowed', async () => {
      const artefactId = await grantConsent('abdm-consent-transfer-one', [firstVisit]);
      const { dataRequestId, requester } = await requestData(
        'abdm-consent-transfer-one',
        'txn-transfer-one',
      );

      gateway.pushes.length = 0;
      expect(await ctx.app.get(TransferService).transfer(dataRequestId)).toBe('transferred');

      expect(gateway.pushes).toHaveLength(1);

      const push = gateway.pushes[0]!;
      expect(push.transactionId).toBe('txn-transfer-one');
      expect(push.entries[0]?.careContextReference).toBe(firstVisit);
      expect(push.entries[0]?.media).toBe('application/fhir+json');

      const { bundle, resourceTypes } = open(push, requester);

      expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'document' });
      // A document bundle leads with what it is.
      expect(resourceTypes[0]).toBe('Composition');
      expect(resourceTypes).toContain('MedicationRequest');
      expect(resourceTypes).toContain('Condition');

      void artefactId;
    }, 60_000);

    it('carries nothing the consent did not allow, and never a note', async () => {
      const artefactId = await grantConsent(
        'abdm-consent-transfer-medicines',
        [firstVisit],
        ['Prescription'],
      );

      const { dataRequestId, requester } = await requestData(
        'abdm-consent-transfer-medicines',
        'txn-transfer-medicines',
      );

      gateway.pushes.length = 0;
      await ctx.app.get(TransferService).transfer(dataRequestId);

      const { resourceTypes } = open(gateway.pushes[0]!, requester);

      expect(resourceTypes).toContain('MedicationRequest');
      // The consent said medicines. The database, not this code, is what
      // kept the diagnosis out.
      expect(resourceTypes).not.toContain('Condition');
      expect(resourceTypes).not.toContain('DocumentReference');

      // And no health information type reaches a clinician's note.
      expect(JSON.stringify(gateway.pushes[0])).not.toContain('Burning after meals');

      void artefactId;
    }, 60_000);

    it('puts every row that left on the patient’s trail, under the consent it rested on', async () => {
      const artefactId = await grantConsent('abdm-consent-transfer-audit', [firstVisit]);
      const { dataRequestId } = await requestData(
        'abdm-consent-transfer-audit',
        'txn-transfer-audit',
      );

      await ctx.app.get(TransferService).transfer(dataRequestId);

      const rows = await owner<Array<{ resource_type: string; action: string; actor_label: string }>>`
        SELECT resource_type, action::text, actor_label
          FROM access_log
         WHERE consent_artefact_id = ${artefactId}
      `;

      const actions = rows.map((row) => row.action);
      expect(actions).toContain('export');
      expect(actions).toContain('read');

      // Attributed to the requester, not to this system in the abstract.
      expect(rows.every((row) => row.actor_label.includes('Shanti Allopathic'))).toBe(true);
      expect(rows.map((row) => row.resource_type)).toContain('MedicationRequest');
    }, 60_000);
  });

  describe('what is written down about it', () => {
    it('records the transfer, and does not make it twice', async () => {
      const artefactId = await grantConsent('abdm-consent-transfer-once', [firstVisit]);
      const { dataRequestId } = await requestData(
        'abdm-consent-transfer-once',
        'txn-transfer-once',
      );

      gateway.pushes.length = 0;
      expect(await ctx.app.get(TransferService).transfer(dataRequestId)).toBe('transferred');
      // A queue that delivers twice must not transfer twice.
      expect(await ctx.app.get(TransferService).transfer(dataRequestId)).toBe('transferred');
      expect(gateway.pushes).toHaveLength(1);

      const [row] = await owner<
        Array<{ status: string; care_contexts_sent: number; completed_at: Date | null }>
      >`
        SELECT status::text, care_contexts_sent, completed_at
          FROM abdm_data_request WHERE id = ${dataRequestId}
      `;

      expect(row).toMatchObject({ status: 'transferred', care_contexts_sent: 1 });
      expect(row?.completed_at).not.toBeNull();

      void artefactId;
    }, 60_000);

    it('refuses a request on a consent that is not in force', async () => {
      await grantConsent('abdm-consent-transfer-revoked', [firstVisit]);

      await gateway.ask('consent.notify', HIP_ID, {
        notification: { status: 'REVOKED', consentId: 'abdm-consent-transfer-revoked' },
      });

      const requester = generateRequesterKeys();

      const answered = await gateway.ask('health-information.request', HIP_ID, {
        transactionId: 'txn-transfer-revoked',
        hiRequest: {
          consent: { id: 'abdm-consent-transfer-revoked' },
          dataPushUrl: gateway.dataPushUrl,
          keyMaterial: {
            dhPublicKey: { keyValue: requester.material.publicKey },
            nonce: requester.material.nonce,
          },
        },
      });

      // Refused at the door, so nothing is written that suggests a transfer
      // is coming.
      expect(answered.status).toBeGreaterThanOrEqual(400);
    }, 60_000);

    it('records a failed push as a failure, having sent nothing', async () => {
      await grantConsent('abdm-consent-transfer-unreachable', [firstVisit]);
      const { dataRequestId } = await requestData(
        'abdm-consent-transfer-unreachable',
        'txn-transfer-unreachable',
      );

      gateway.pushFailsWith = 503;

      try {
        expect(await ctx.app.get(TransferService).transfer(dataRequestId)).toBe('failed');
      } finally {
        gateway.pushFailsWith = null;
      }

      const [row] = await owner<Array<{ status: string; failure_reason: string }>>`
        SELECT status::text, failure_reason FROM abdm_data_request WHERE id = ${dataRequestId}
      `;

      expect(row?.status).toBe('failed');
      expect(row?.failure_reason).toMatch(/503/);
    }, 60_000);
  });

  /**
   * The test this phase exists to be able to pass. The patient changes their
   * mind halfway through, and the second visit never leaves the building.
   */
  describe('when the consent is withdrawn mid-transfer', () => {
    it('sends what it had started and stops, and says so', async () => {
      const artefactId = await grantConsent('abdm-consent-transfer-stopped', [
        firstVisit,
        secondVisit,
      ]);

      const { dataRequestId } = await requestData(
        'abdm-consent-transfer-stopped',
        'txn-transfer-stopped',
      );

      gateway.pushes.length = 0;

      // Withdrawn the moment the first bundle lands at the requester.
      gateway.onPush = async () => {
        await owner`
          UPDATE consent_artefact
             SET status = 'revoked', revoked_at = now(),
                 revocation_reason = 'The patient changed their mind'
           WHERE id = ${artefactId} AND status = 'active'
        `;
      };

      try {
        expect(await ctx.app.get(TransferService).transfer(dataRequestId)).toBe(
          'partly_transferred',
        );
      } finally {
        gateway.onPush = null;
      }

      // One visit went. The other never did.
      expect(gateway.pushes).toHaveLength(1);
      expect(gateway.pushes[0]?.entries[0]?.careContextReference).toBe(firstVisit);

      const [row] = await owner<
        Array<{ status: string; care_contexts_sent: number; care_contexts_requested: number; failure_reason: string }>
      >`
        SELECT status::text, care_contexts_sent, care_contexts_requested, failure_reason
          FROM abdm_data_request WHERE id = ${dataRequestId}
      `;

      expect(row).toMatchObject({
        status: 'partly_transferred',
        care_contexts_sent: 1,
        care_contexts_requested: 2,
      });

      // Recorded as what it was, not rounded to "done" or "failed".
      expect(row?.failure_reason).toMatch(/withdrawn while the transfer was running/);

      // And the second visit is on nobody's trail as having left.
      const [audited] = await owner<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM access_log
         WHERE consent_artefact_id = ${artefactId}
           AND resource_id = ${secondVisit}
      `;

      expect(audited?.count).toBe(0);
    }, 90_000);
  });
});
