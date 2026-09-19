import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { GuardianHandover } from '../src/modules/notifications/guardian-handover';
import { LogSmsSender } from '../src/modules/portal/sms';
import {
  appRoleDb,
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

const istToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** Midnight in India at the start of a calendar date, as an instant. */
const istMidnight = (date: string) => new Date(`${date}T00:00:00+05:30`).toISOString();

/**
 * Dependants (SP5 Phase 7, Decision M1): a child's record linked to a guardian
 * at the desk, the guardian acting for the child in the portal, and the
 * hand-over at the child's 18th birthday.
 */
describe('guardians and the hand-over at 18', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;

  let hospitalA: string;
  let deskToken: string;
  let recordsToken: string;
  let clinicianToken: string;
  let deskId: string;

  let childId: string;
  let childBirthDate: string;
  let noBirthDateId: string;
  let adultId: string;
  let turningAdultId: string;
  let guardianAccessId: string;

  const GUARDIAN_PHONE = '9820044101';
  const TURNING_ADULT_PHONE = '+919820044202';
  const GUARDIAN = {
    phone: GUARDIAN_PHONE,
    guardianName: 'Sunita Guardian',
    guardianRelation: 'mother',
    documentChecked: 'Birth certificate',
    relationshipConfirmed: true,
  };

  const post = (path: string, bearer: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (bearer ? request.set('Authorization', `Bearer ${bearer}`) : request).send(body);
  };

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  async function asSystem<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  async function verify(phone: string) {
    await owner`DELETE FROM otp_challenge`;
    await post('/portal/auth/otp', null, { phone });
    const code = sms.lastTo(`+91${phone}`)?.body.slice(0, 6);
    const verified = await post('/portal/auth/verify', null, { phone, code });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    return verified.body as {
      selectionToken: string;
      patients: Array<{ id: string; name: string; relationship: string }>;
    };
  }

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);

    const a = await seedHospital({ name: 'Sanjeevani Guardian Test', mrnPrefix: 'SGT' });
    hospitalA = a.hospital.id;
    deskId = (a.staff.frontDesk as SeededStaff).id;
    deskToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    recordsToken = await signIn(ctx, a.staff.records as SeededStaff);
    clinicianToken = await signIn(ctx, a.staff.clinician as SeededStaff);

    const year = Number(istToday().slice(0, 4));
    childBirthDate = `${year - 10}-03-15`;

    childId = (
      await post('/patients', deskToken, {
        name: 'Aarav Child',
        gender: 'male',
        dateOfBirth: childBirthDate,
        phone: '9820044102',
      })
    ).body.patient.id;

    noBirthDateId = (
      await post('/patients', deskToken, {
        name: 'Meera Approximate',
        gender: 'female',
        approximateAgeYears: 9,
        phone: '9820044103',
      })
    ).body.patient.id;

    adultId = (
      await post('/patients', deskToken, {
        name: 'Rohan Adult',
        gender: 'male',
        dateOfBirth: '1990-06-01',
        phone: '9820044104',
      })
    ).body.patient.id;

    // Turns 18 today, in India.
    const eighteenToday = `${year - 18}${istToday().slice(4)}`;
    turningAdultId = (
      await post('/patients', deskToken, {
        name: 'Isha Turning',
        gender: 'female',
        dateOfBirth: eighteenToday,
        phone: TURNING_ADULT_PHONE.slice(3),
      })
    ).body.patient.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  }, 120_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('links a child to a guardian at the desk, until the child’s 18th birthday', async () => {
    const linked = await post(`/patients/${childId}/portal-access/guardian`, deskToken, GUARDIAN);
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);

    const eighteenth = `${Number(childBirthDate.slice(0, 4)) + 18}${childBirthDate.slice(4)}`;
    expect(linked.body).toMatchObject({
      relationship: 'guardian',
      status: 'active',
      phone: `+91${GUARDIAN_PHONE}`,
      endsAt: istMidnight(eighteenth),
      guardian: { name: 'Sunita Guardian', relation: 'mother', documentChecked: 'Birth certificate' },
    });
    guardianAccessId = linked.body.id;

    const listed = await get(`/patients/${childId}/portal-access`, recordsToken);
    expect(listed.body).toEqual([expect.objectContaining({ id: guardianAccessId, relationship: 'guardian' })]);
  });

  it('refuses a guardian link without a date of birth, for an adult, without the checks, or from a clinician', async () => {
    const noBirthDate = await post(`/patients/${noBirthDateId}/portal-access/guardian`, recordsToken, GUARDIAN);
    expect(noBirthDate.status, JSON.stringify(noBirthDate.body)).toBe(400);

    const adult = await post(`/patients/${adultId}/portal-access/guardian`, recordsToken, GUARDIAN);
    expect(adult.status, JSON.stringify(adult.body)).toBe(400);

    for (const missing of ['documentChecked', 'relationshipConfirmed', 'guardianName']) {
      const { [missing]: _removed, ...body } = GUARDIAN as Record<string, unknown>;
      expect((await post(`/patients/${childId}/portal-access/guardian`, deskToken, body)).status, missing).toBe(400);
    }

    expect((await post(`/patients/${childId}/portal-access/guardian`, clinicianToken, GUARDIAN)).status).toBe(403);
  });

  it('lets the guardian act for the child in the portal', async () => {
    const verified = await verify(GUARDIAN_PHONE);
    expect(verified.patients).toEqual([
      expect.objectContaining({ id: childId, name: 'Aarav Child', relationship: 'guardian' }),
    ]);

    const session = await post('/portal/auth/session', null, {
      selectionToken: verified.selectionToken,
      patientId: childId,
    });
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    const bearer = session.body.accessToken as string;

    expect((await get('/portal/auth/me', bearer)).body.patient).toMatchObject({
      id: childId,
      relationship: 'guardian',
    });
    expect((await get('/portal/summary', bearer)).body.patient.name).toBe('Aarav Child');
    expect((await get('/portal/consents', bearer)).status).toBe(200);
  });

  it('hands the record over at 18: the guardian’s sessions end, and the young adult is told once', async () => {
    // A guardian linked a year ago for a child who turns 18 today.
    const { accessId, sessionId } = await asSystem(async (tx) => {
      const guardianPhone = '+919820044301';
      const [account] = await tx<Array<{ id: string }>>`
        INSERT INTO patient_account (id, phone) VALUES (gen_random_uuid(), ${guardianPhone}) RETURNING id
      `;
      const [born] = await tx<Array<{ date_of_birth: string }>>`
        SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth FROM patient WHERE id = ${turningAdultId}
      `;
      const [access] = await tx<Array<{ id: string }>>`
        INSERT INTO patient_portal_access
          (account_id, patient_id, phone, relationship, activated_at_hospital_id, activated_by_staff_id,
           activated_at, ends_at, guardian_name, guardian_relation, guardian_document)
        VALUES (${account!.id}, ${turningAdultId}, ${guardianPhone}, 'guardian', ${hospitalA}, ${deskId},
                now() - interval '1 year',
                ((${born!.date_of_birth}::date + interval '18 years')::date::timestamp) AT TIME ZONE 'Asia/Kolkata',
                'Kavita Guardian', 'mother', 'School leaving certificate')
        RETURNING id
      `;
      const [session] = await tx<Array<{ id: string }>>`
        INSERT INTO patient_session (id, account_id, patient_id, refresh_token_hash, expires_at)
        VALUES (gen_random_uuid(), ${account!.id}, ${turningAdultId}, ${randomBytes(16).toString('hex')}, now() + interval '30 days')
        RETURNING id
      `;
      return { accessId: access!.id, sessionId: session!.id };
    });

    const handover = ctx.app.get(GuardianHandover);
    expect(await handover.handOverDue()).toBeGreaterThanOrEqual(1);

    const state = await asSystem(async (tx) => {
      const [access] = await tx<Array<{ handed_over_at: string | null }>>`
        SELECT handed_over_at::text FROM patient_portal_access WHERE id = ${accessId}
      `;
      const [session] = await tx<Array<{ revoked_at: string | null; revoked_reason: string | null }>>`
        SELECT revoked_at::text, revoked_reason FROM patient_session WHERE id = ${sessionId}
      `;
      return { access: access!, session: session! };
    });

    expect(state.access.handed_over_at).toBeTruthy();
    expect(state.session).toMatchObject({ revoked_reason: 'guardian access ended at 18' });
    expect(state.session.revoked_at).toBeTruthy();

    const message = sms.lastTo(TURNING_ADULT_PHONE);
    expect(message).toMatchObject({ template: 'guardian_handover' });
    expect(message!.body).toContain('18');

    expect(await handover.handOver(accessId)).toBe('skipped');

    // The child's own access is untouched by any of this.
    expect(await handover.handOver(guardianAccessId)).toBe('skipped');
  });

  it('in the database, records a guardian’s details only on a guardian access, and leaves the hand-over to the system', async () => {
    const { client: app, close } = appRoleDb();

    try {
      await expect(
        asSystem(async (tx) => {
          const [account] = await tx<Array<{ id: string }>>`
            INSERT INTO patient_account (id, phone) VALUES (gen_random_uuid(), '+919820044401') RETURNING id
          `;
          await tx`
            INSERT INTO patient_portal_access
              (account_id, patient_id, phone, relationship, activated_at_hospital_id, activated_by_staff_id, guardian_name)
            VALUES (${account!.id}, ${adultId}, '+919820044401', 'self', ${hospitalA}, ${deskId}, 'Not A Guardian')
          `;
        }),
      ).rejects.toThrow(/patient_portal_access_guardian_details/);

      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalA}, true)`;
          await tx`UPDATE patient_portal_access SET handed_over_at = now() WHERE id = ${guardianAccessId}`;
        }),
      ).rejects.toThrow(/only the system/);
    } finally {
      await close();
    }
  });
});
