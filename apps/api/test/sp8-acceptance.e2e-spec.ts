import { generateKeyPairSync, randomBytes } from 'node:crypto';
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
 * The SP8 acceptance scenario, walked (sp8-plan.md, T35).
 *
 * Lakshmi has an ABHA. She is treated at the Ayurvedic clinic on this
 * platform, and an allopathic hospital that is not on it asks for her records
 * through the national network. Eight of the scenario's nine steps are here,
 * in order, each one depending on the last; the ninth is a question answered
 * by a document rather than by a test, and `docs/compliance/sp8-acceptance.md`
 * records how it went.
 *
 * It is deliberately one long test rather than eight. The scenario is a
 * sequence — nothing after step 2 is meaningful if step 2 did not happen —
 * and splitting it would let a later step pass against a state an earlier one
 * never produced.
 */
describe('SP8 acceptance: Lakshmi, her ABHA, and the hospital that is not on this platform', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let app: postgres.Sql;
  const closers: Array<() => Promise<void>> = [];

  let gateway: MockGatewayServer;
  let hospital: { id: string };
  let frontDesk: SeededStaff;
  let clinician: SeededStaff;
  let token: string;
  let clinicianToken: string;

  const HIP_ID = 'HFR-SANJEEVANI-0001';
  const CALLBACK_SECRET = 'a-shared-secret-for-callbacks';
  const ABHA = 'lakshmi.devi@abdm';
  const HIU = { id: 'shanti-hiu@cm', name: 'Shanti Allopathic (HIU)' };
  const CONSENT_ID = 'abdm-consent-acceptance';

  const before: Record<string, string | undefined> = {};

  const post = (path: string, body: Record<string, unknown> = {}, as = token) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${as}`).send(body);

  const get = (path: string, as = token) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${as}`);

  const isoDay = (offset: number): string => {
    const at = new Date();
    at.setUTCDate(at.getUTCDate() + offset);
    return at.toISOString();
  };

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();

    const seeded = await seedHospital({ name: 'Sanjeevani Ayurveda', mrnPrefix: 'SJT' });
    hospital = seeded.hospital;
    frontDesk = seeded.staff.frontDesk!;
    clinician = seeded.staff.clinician!;

    gateway = new MockGatewayServer({
      clientId: 'health24-acceptance',
      clientSecret: 'not-a-real-client-secret',
      callbackSecret: CALLBACK_SECRET,
    });

    await gateway.start();
    closers.push(() => gateway.stop());

    for (const [key, value] of Object.entries({
      ABDM_MODE: 'gateway',
      ABDM_GATEWAY_URL: gateway.url,
      ABDM_CLIENT_ID: 'health24-acceptance',
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
  }, 180_000);

  afterAll(async () => {
    for (const close of closers) await close();

    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('walks the scenario end to end', async () => {
    // ---- She is registered, and treated --------------------------------
    const registered = await post('/patients', {
      name: 'Lakshmi Devi',
      gender: 'female',
      dateOfBirth: '1986-07-19',
      phone: '+919812345675',
      forceCreate: true,
    });

    expect(registered.status).toBe(201);
    const patientId = (registered.body as { patient: { id: string } }).patient.id;

    const encounter = await post('/encounters', { patientId }, clinicianToken);
    const encounterId = (encounter.body as { id: string }).id;

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
      { encounterId, template: 'general', sections: { subjective: 'She says it burns at night' } },
      clinicianToken,
    );

    // ---- 1. Front-desk confirms her ABHA -------------------------------
    const challenge = await post(`/patients/${patientId}/abha/verification`, {
      abhaAddress: ABHA,
      method: 'mobile_otp',
    });

    expect(challenge.status, JSON.stringify(challenge.body)).toBe(201);

    const verified = await post(`/patients/${patientId}/abha/verification/confirm`, {
      transactionId: (challenge.body as { transactionId: string }).transactionId,
      code: MOCK_GATEWAY_CODE,
    });

    expect(verified.status).toBe(201);
    expect(verified.body).toMatchObject({ abhaAddress: ABHA, verified: true });

    // And the use of her identity is on her trail, whether or not anything
    // came of it.
    const [askedAbout] = await owner<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM access_log
       WHERE patient_id = ${patientId} AND resource_type = 'patient' AND action = 'read'
    `;

    expect(askedAbout?.count ?? 0).toBeGreaterThan(0);

    // ---- 2. The visit goes on to the network, only once she confirms ---
    const offered = await post(`/patients/${patientId}/care-contexts/link`, {
      encounterIds: [encounterId],
    });

    expect(offered.status).toBe(201);

    // Nothing yet.
    const [beforeConfirm] = await owner<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM abdm_care_context WHERE encounter_id = ${encounterId}
    `;
    expect(beforeConfirm?.count).toBe(0);

    const linked = await post(`/patients/${patientId}/care-contexts/link/confirm`, {
      linkRequestId: (offered.body as { linkRequestId: string }).linkRequestId,
      code: MOCK_GATEWAY_CODE,
    });

    expect(linked.status).toBe(201);

    // ---- 3 and 4. The consent manager notifies a consent ----------------
    const notified = await gateway.ask('consent.notify', HIP_ID, {
      notification: {
        status: 'GRANTED',
        consentId: CONSENT_ID,
        consentDetail: {
          hiu: HIU,
          careContexts: [{ careContextReference: encounterId }],
          // Diagnoses and medicines. Not her notes, and not her documents.
          hiTypes: ['Prescription', 'OPConsultation'],
          permission: {
            dateRange: { from: isoDay(-180), to: isoDay(1) },
            dataEraseAt: isoDay(30),
          },
        },
      },
    });

    expect(notified.status).toBe(202);

    const [artefact] = await owner<
      Array<{ id: string; source: string; grantee_hospital_id: string | null }>
    >`
      SELECT id, source::text, grantee_hospital_id
        FROM consent_artefact WHERE abdm_consent_id = ${CONSENT_ID}
    `;

    expect(artefact).toMatchObject({ source: 'abdm', grantee_hospital_id: null });

    // Step 4's real claim: a member of staff at the clinic sees nothing
    // different. The artefact grants a third party, not them — so their own
    // list of "what we may read" is unchanged, and it is empty.
    const consents = await get(`/patients/${patientId}/consents`);
    expect(consents.status).toBe(200);
    expect(consents.body).toEqual([]);

    // The clinic can see that a requester was given something of its record,
    // on the screen that is about exactly that — which is not the same list
    // and does not claim to be.
    const given = await get(`/patients/${patientId}/consents?source=abdm`);
    expect(given.status).toBe(200);
    expect(given.body).toHaveLength(1);
    expect((given.body as Array<{ captureMethod: string }>)[0]?.captureMethod).toBe('abdm');

    // ---- 5. The records leave, and only what was agreed ------------------
    const requested = await gateway.ask('health-information.request', HIP_ID, {
      transactionId: 'acceptance-transfer',
      hiRequest: {
        consent: { id: CONSENT_ID },
        dataPushUrl: gateway.dataPushUrl,
        keyMaterial: {
          cryptoAlg: 'ECDH',
          curve: 'Curve25519',
          dhPublicKey: { keyValue: requesterPublicKey() },
          nonce: Buffer.from(randomBytes(32)).toString('base64'),
        },
      },
    });

    expect(requested.status).toBe(202);

    const [dataRequest] = await owner<Array<{ id: string }>>`
      SELECT id FROM abdm_data_request WHERE abdm_transaction_id = 'acceptance-transfer'
    `;

    gateway.pushes.length = 0;

    const { TransferService } = await import('../src/modules/abdm/transfer/transfer.service');
    expect(await ctx.app.get(TransferService).transfer(dataRequest!.id)).toBe('transferred');

    expect(gateway.pushes).toHaveLength(1);

    const pushed = JSON.stringify(gateway.pushes[0]);
    // The bundle is encrypted: her complaint is not in the push in clear.
    expect(pushed).not.toContain('burns at night');
    expect(gateway.pushes[0]?.entries[0]?.careContextReference).toBe(encounterId);

    // ---- 6. Every row that left is on her trail --------------------------
    const trail = await owner<Array<{ action: string; actor_label: string; resource_type: string }>>`
      SELECT action::text, actor_label, resource_type
        FROM access_log WHERE consent_artefact_id = ${artefact!.id}
    `;

    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((row) => row.actor_label.includes('Shanti Allopathic'))).toBe(true);
    expect(trail.map((row) => row.action)).toContain('export');
    expect(trail.map((row) => row.resource_type)).toContain('MedicationRequest');
    // Her notes are on nobody's trail as having left, because they did not.
    expect(trail.map((row) => row.resource_type)).not.toContain('clinical_note');

    // ---- 7. She revokes it, and the next request is refused --------------
    const revoked = await gateway.ask('consent.notify', HIP_ID, {
      notification: { status: 'REVOKED', consentId: CONSENT_ID },
    });

    expect(revoked.status).toBe(202);

    const second = await gateway.ask('health-information.request', HIP_ID, {
      transactionId: 'acceptance-transfer-again',
      hiRequest: {
        consent: { id: CONSENT_ID },
        dataPushUrl: gateway.dataPushUrl,
        keyMaterial: {
          dhPublicKey: { keyValue: requesterPublicKey() },
          nonce: Buffer.from(randomBytes(32)).toString('base64'),
        },
      },
    });

    expect(second.status).toBeGreaterThanOrEqual(400);

    // And nothing was written that suggests a transfer is coming.
    const [pending] = await owner<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM abdm_data_request
       WHERE abdm_transaction_id = 'acceptance-transfer-again'
    `;
    expect(pending?.count).toBe(0);

    // The database agrees: the assembly context now yields nothing.
    const stillReadable = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_abdm_consent_id', ${artefact!.id}, true)`;
      return tx`SELECT id FROM medication_request`;
    });

    expect(stillReadable).toHaveLength(0);

    // ---- 8. A FHIR client reads the same record --------------------------
    const capability = await ctx.http().get('/fhir/R4/metadata');
    expect(capability.status).toBe(200);
    expect(capability.body).toMatchObject({ resourceType: 'CapabilityStatement' });

    const conditions = await ctx
      .http()
      .get(`/fhir/R4/Condition?patient=${patientId}`)
      .set('Authorization', `Bearer ${clinicianToken}`);

    expect(conditions.status).toBe(200);
    expect((conditions.body as { total: number }).total).toBeGreaterThan(0);

    // And it grants nothing: the same request without a token is refused.
    expect((await ctx.http().get(`/fhir/R4/Condition?patient=${patientId}`)).status).toBe(401);
  }, 180_000);
});

/** A raw X25519 public key in base64, as a requester sends. */
function requesterPublicKey(): string {
  const { publicKey } = generateKeyPairSync('x25519');
  return publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
}
