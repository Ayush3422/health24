import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { LogSmsSender } from '../src/modules/portal/sms';
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
 * Patient portal sign-in end to end (SP5 Phase 1): access activated at a
 * hospital desk, a one-time code by SMS, the patient chosen among those on the
 * phone, sessions that rotate and revoke — and tokens that never cross between
 * the portal and the staff application.
 */
describe('patient portal sign-in', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;

  let frontDeskA: string;
  let frontDeskB: string;
  let clinicianA: string;

  const PHONE = '+919820099001';
  const STRANGER = '+919820099999';

  const lakshmi = {
    name: 'Lakshmi Portal',
    gender: 'female',
    dateOfBirth: '1968-04-12',
    phone: '9820099001',
  };

  let lakshmiId: string;
  let raviId: string;
  let withoutAccessId: string;
  let accessId: string;

  const get = (path: string, token?: string) => {
    const request = ctx.http().get(`/api/v1${path}`);
    return token ? request.set('Authorization', `Bearer ${token}`) : request;
  };

  const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (token ? request.set('Authorization', `Bearer ${token}`) : request).send(body);
  };

  /** Codes are limited per number; tests start each sign-in afresh. */
  const clearCodes = () => owner`DELETE FROM otp_challenge`;

  const latestCode = (phone: string) => {
    const message = sms.lastTo(phone);
    return message?.body.match(/^(\d{6}) /)?.[1];
  };

  async function verifiedSelection(phone = PHONE) {
    await clearCodes();
    expect((await post('/portal/auth/otp', null, { phone })).status).toBe(202);

    const verified = await post('/portal/auth/verify', null, { phone, code: latestCode(phone) });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);

    return verified.body as { selectionToken: string; patients: Array<{ id: string; name: string }> };
  }

  async function signInAs(patientId: string) {
    const { selectionToken } = await verifiedSelection();
    const session = await post('/portal/auth/session', null, { selectionToken, patientId });
    expect(session.status, JSON.stringify(session.body)).toBe(200);

    return session.body as { accessToken: string; refreshToken: string };
  }

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);

    const a = await seedHospital({ name: 'Sanjeevani Portal Test', mrnPrefix: 'SPT' });
    const b = await seedHospital({
      name: 'City General Portal Test',
      mrnPrefix: 'GPT',
      facilityType: 'allopathic',
    });

    frontDeskA = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    frontDeskB = await signIn(ctx, b.staff.frontDesk as SeededStaff);
    clinicianA = await signIn(ctx, a.staff.clinician as SeededStaff);

    lakshmiId = (await post('/patients', frontDeskA, lakshmi)).body.patient.id;
    raviId = (
      await post('/patients', frontDeskA, {
        name: 'Ravi Portal',
        gender: 'male',
        dateOfBirth: '1995-09-01',
        phone: '9820099001',
      })
    ).body.patient.id;
    withoutAccessId = (
      await post('/patients', frontDeskA, {
        name: 'Meena Elsewhere',
        gender: 'female',
        dateOfBirth: '1980-01-01',
        phone: '9820099002',
      })
    ).body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  });

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('activates portal access at the desk, once per patient, with identity confirmed in person', async () => {
    const activated = await post(`/patients/${lakshmiId}/portal-access`, frontDeskA, {
      phone: lakshmi.phone,
      identityConfirmed: true,
    });

    expect(activated.status, JSON.stringify(activated.body)).toBe(201);
    expect(activated.body).toMatchObject({
      patientId: lakshmiId,
      phone: PHONE,
      relationship: 'self',
      status: 'active',
      activatedAtHospital: { isOwn: true },
    });
    accessId = activated.body.id;

    const again = await post(`/patients/${lakshmiId}/portal-access`, frontDeskA, {
      phone: lakshmi.phone,
      identityConfirmed: true,
    });
    expect(again.body.id).toBe(accessId);

    expect(
      (await post(`/patients/${raviId}/portal-access`, frontDeskA, { phone: lakshmi.phone })).status,
    ).toBe(400);
    expect(
      (
        await post(`/patients/${raviId}/portal-access`, frontDeskA, {
          phone: lakshmi.phone,
          identityConfirmed: true,
        })
      ).status,
    ).toBe(201);

    // Another hospital that does not hold the patient cannot turn the portal on.
    expect(
      (
        await post(`/patients/${lakshmiId}/portal-access`, frontDeskB, {
          phone: lakshmi.phone,
          identityConfirmed: true,
        })
      ).status,
    ).toBe(404);
  });

  it('sends a code only to a number with access, and answers a stranger the same way', async () => {
    await clearCodes();

    const known = await post('/portal/auth/otp', null, { phone: lakshmi.phone });
    const stranger = await post('/portal/auth/otp', null, { phone: '9820099999' });

    expect(known.status).toBe(202);
    expect(stranger.status).toBe(202);
    expect(stranger.body).toEqual(known.body);
    expect(known.body).toEqual({ sent: true, expiresInSeconds: 300 });

    expect(latestCode(PHONE)).toMatch(/^\d{6}$/);
    expect(sms.lastTo(STRANGER)).toBeUndefined();

    // The code is stored only as a keyed hash.
    const [stored] = await owner<Array<{ code_hash: string }>>`
      SELECT code_hash FROM otp_challenge WHERE phone = ${PHONE} ORDER BY created_at DESC LIMIT 1
    `;
    expect(stored!.code_hash).not.toContain(latestCode(PHONE)!);
  });

  it('limits codes per number, known or not', async () => {
    await clearCodes();

    for (let request = 0; request < 3; request += 1) {
      expect((await post('/portal/auth/otp', null, { phone: '9820099999' })).status).toBe(202);
    }
    expect((await post('/portal/auth/otp', null, { phone: '9820099999' })).status).toBe(429);
  });

  it('signs in with the code, then the patient chosen among those on the phone', async () => {
    await clearCodes();
    await post('/portal/auth/otp', null, { phone: lakshmi.phone });
    const code = latestCode(PHONE)!;
    const wrong = code === '000000' ? '111111' : '000000';

    expect((await post('/portal/auth/verify', null, { phone: lakshmi.phone, code: wrong })).status).toBe(
      401,
    );

    const verified = await post('/portal/auth/verify', null, { phone: lakshmi.phone, code });
    expect(verified.status).toBe(200);
    expect(verified.body.patients.map((patient: { name: string }) => patient.name)).toEqual([
      'Lakshmi Portal',
      'Ravi Portal',
    ]);

    // A code is spent once.
    expect((await post('/portal/auth/verify', null, { phone: lakshmi.phone, code })).status).toBe(401);

    const session = await post('/portal/auth/session', null, {
      selectionToken: verified.body.selectionToken,
      patientId: lakshmiId,
    });
    expect(session.status).toBe(200);

    const me = await get('/portal/auth/me', session.body.accessToken);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      patient: { id: lakshmiId, name: 'Lakshmi Portal', relationship: 'self' },
      phone: '+91••••••9001',
    });
    expect(me.body.patients).toHaveLength(2);

    const [audited] = await owner<Array<{ actor_type: string; patient_id: string }>>`
      SELECT actor_type, patient_id::text FROM access_log
       WHERE resource_type = 'portal_session' ORDER BY at DESC LIMIT 1
    `;
    expect(audited).toEqual({ actor_type: 'patient', patient_id: lakshmiId });
  });

  it('spends a code after five wrong attempts', async () => {
    await clearCodes();
    await post('/portal/auth/otp', null, { phone: lakshmi.phone });
    const code = latestCode(PHONE)!;
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (await post('/portal/auth/verify', null, { phone: lakshmi.phone, code: wrong })).status,
      ).toBe(401);
    }
    expect((await post('/portal/auth/verify', null, { phone: lakshmi.phone, code })).status).toBe(401);
  });

  it('refuses a code past its five minutes', async () => {
    await clearCodes();
    await post('/portal/auth/otp', null, { phone: lakshmi.phone });
    const code = latestCode(PHONE)!;

    // The database keeps a code's life after its creation, so the whole row moves back.
    await owner`
      UPDATE otp_challenge
         SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'
       WHERE phone = ${PHONE}
    `;

    expect((await post('/portal/auth/verify', null, { phone: lakshmi.phone, code })).status).toBe(401);
  });

  it('refuses a patient the phone has no access to, and a stale selection', async () => {
    const { selectionToken } = await verifiedSelection();

    expect(
      (await post('/portal/auth/session', null, { selectionToken, patientId: withoutAccessId }))
        .status,
    ).toBe(403);
    expect(
      (await post('/portal/auth/session', null, { selectionToken: 'forged', patientId: lakshmiId }))
        .status,
    ).toBe(401);
  });

  it('rotates refresh tokens, and a replayed one ends every session of the phone', async () => {
    const first = await signInAs(lakshmiId);

    const rotated = await post('/portal/auth/refresh', null, { refreshToken: first.refreshToken });
    expect(rotated.status).toBe(200);
    expect((await get('/portal/auth/me', rotated.body.accessToken)).status).toBe(200);

    expect((await post('/portal/auth/refresh', null, { refreshToken: first.refreshToken })).status).toBe(
      401,
    );
    expect((await get('/portal/auth/me', rotated.body.accessToken)).status).toBe(401);
  });

  it('switches to another patient on the phone, ending the session it came from', async () => {
    const session = await signInAs(lakshmiId);

    const switched = await post('/portal/auth/switch', session.accessToken, { patientId: raviId });
    expect(switched.status).toBe(200);
    expect(switched.body.patient).toMatchObject({ id: raviId, name: 'Ravi Portal' });

    expect((await get('/portal/auth/me', session.accessToken)).status).toBe(401);
    expect((await get('/portal/auth/me', switched.body.accessToken)).body.patient.id).toBe(raviId);
  });

  it('lists sessions, ends one from another device, and signs out', async () => {
    const phone = await signInAs(lakshmiId);
    const laptop = await signInAs(lakshmiId);

    const sessions = await get('/portal/auth/sessions', laptop.accessToken);
    expect(sessions.status).toBe(200);
    const others = (sessions.body as Array<{ id: string; current: boolean }>).filter(
      (session) => !session.current,
    );
    expect(others.length).toBeGreaterThan(0);

    for (const other of others) {
      const ended = await ctx
        .http()
        .delete(`/api/v1/portal/auth/sessions/${other.id}`)
        .set('Authorization', `Bearer ${laptop.accessToken}`);
      expect(ended.status).toBe(204);
    }
    expect((await get('/portal/auth/me', phone.accessToken)).status).toBe(401);

    expect((await post('/portal/auth/logout', laptop.accessToken)).status).toBe(204);
    expect((await get('/portal/auth/me', laptop.accessToken)).status).toBe(401);
  });

  it('keeps a patient token off staff routes, and a staff token off portal routes', async () => {
    const session = await signInAs(lakshmiId);

    for (const path of [
      `/patients/${lakshmiId}`,
      `/patients/${lakshmiId}/timeline`,
      `/patients/${lakshmiId}/documents`,
      '/auth/me',
    ]) {
      expect((await get(path, session.accessToken)).status, path).toBe(401);
    }

    expect((await get('/portal/auth/me', clinicianA)).status).toBe(401);
    expect((await get('/portal/auth/sessions', frontDeskA)).status).toBe(401);
  });

  it('ends the portal at once when any hospital the patient is linked to revokes access', async () => {
    const session = await signInAs(lakshmiId);

    const linked = await post('/patients', frontDeskB, lakshmi);
    expect(linked.body.linkedExisting).toBe(true);

    const listed = await get(`/patients/${lakshmiId}/portal-access`, frontDeskB);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ id: accessId, status: 'active', activatedAtHospital: expect.objectContaining({ isOwn: false }) }),
    ]);

    const revoked = await post(`/portal-access/${accessId}/revoke`, frontDeskB, {
      reason: 'Patient reports a lost phone',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', revokedReason: 'Patient reports a lost phone' });

    expect((await get('/portal/auth/me', session.accessToken)).status).toBe(401);

    const { patients } = await verifiedSelection();
    expect(patients.map((patient) => patient.id)).toEqual([raviId]);

    expect(
      (await post(`/portal-access/${accessId}/revoke`, frontDeskA, { reason: 'Again' })).status,
    ).toBe(409);
  });
});
