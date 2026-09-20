import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Worker } from 'bullmq';
import { ExportBuilder } from '../src/modules/exports/export-builder';
import { BreakGlassNotifier } from '../src/modules/notifications/break-glass-notifier';
import { createNotificationWorker } from '../src/modules/notifications/notification.worker';
import { LogSmsSender } from '../src/modules/portal/sms';
import { StorageService } from '../src/modules/storage/storage.service';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

type TimelineItem = { kind: string; category: string; hospital: { isOwn: boolean } };

type HistoryEntry = {
  actor: { kind: string; name?: string | null; role?: string | null };
  hospital: { id: string; name: string } | null;
  resources: string[];
  emergencyReason: string | null;
  consents: Array<{ captureMethod: string; grantedByYou: boolean }>;
};

/**
 * The SP5 acceptance scenario (sp5-plan.md), continuing the Amlapitta story
 * from SP3 and SP4: Lakshmi signs in to the portal, shares with City General,
 * sees who read her record, is told of emergency access, stops the sharing,
 * carries an emergency card, and takes a copy of her record away.
 *
 * Steps 4 and 5 of the plan are exercised the other way round — she stops the
 * sharing, and only then does a casualty doctor take emergency access — so
 * that each assertion has one cause: emergency access covers every category,
 * and would otherwise hide whether revoking the consent had done anything.
 */
describe('SP5 acceptance: Lakshmi and her record', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;
  let worker: Worker;

  let sanjeevani: string;
  let cityGeneral: string;
  let gastroenterologist: string;
  let casualtyDoctor: string;
  let gastroenterologistName: string;

  let lakshmiId: string;
  let consentId: string;
  let cardToken: string;

  const LAKSHMI = { name: 'Lakshmi Amlapitta', gender: 'female', dateOfBirth: '1968-04-12', phone: '9820099301' };
  const EMERGENCY_REASON = 'Brought in with severe pain; needs her allergy and report history now';

  const post = (path: string, bearer: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (bearer ? request.set('Authorization', `Bearer ${bearer}`) : request).send(body);
  };

  const get = (path: string, bearer?: string) => {
    const request = ctx.http().get(`/api/v1${path}`);
    return bearer ? request.set('Authorization', `Bearer ${bearer}`) : request;
  };

  async function asSystem<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return owner.begin(async (tx) => {
      await tx`SELECT set_config('app.system_context', 'on', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  /** As Lakshmi does it on her phone: a code by SMS, then her own record. */
  async function signInToPortal(): Promise<string> {
    await owner`DELETE FROM otp_challenge`;
    expect((await post('/portal/auth/otp', null, { phone: LAKSHMI.phone })).status).toBe(202);

    const code = sms.lastTo(`+91${LAKSHMI.phone}`)?.body.match(/^(\d{6}) /)?.[1];
    const verified = await post('/portal/auth/verify', null, { phone: LAKSHMI.phone, code });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);

    const session = await post('/portal/auth/session', null, {
      selectionToken: verified.body.selectionToken,
      patientId: lakshmiId,
    });
    expect(session.status, JSON.stringify(session.body)).toBe(200);

    return session.body.accessToken as string;
  }

  /** What City General's gastroenterologist can see of her record from elsewhere. */
  async function sharedWithCityGeneral(): Promise<string[]> {
    const response = await get(`/patients/${lakshmiId}/timeline`, gastroenterologist);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    return [
      ...new Set(
        (response.body.items as TimelineItem[])
          .filter((item) => !item.hospital.isOwn)
          .map((item) => item.category),
      ),
    ].sort();
  }

  beforeAll(async () => {
    process.env.NOTIFICATION_QUEUE_NAME = `patient-notifications-acceptance-${randomUUID()}`;
    process.env.EXPORT_QUEUE_NAME = `patient-exports-acceptance-${randomUUID()}`;

    await resetDatabase();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);
    await ctx.app.get(StorageService).ensureBucket();

    worker = createNotificationWorker({
      notifier: ctx.app.get(BreakGlassNotifier),
      redisUrl: process.env.REDIS_URL!,
      queueName: process.env.NOTIFICATION_QUEUE_NAME,
    });

    const a = await seedHospital({ name: 'Sanjeevani Ayurvedic Hospital', mrnPrefix: 'SAA' });
    const b = await seedHospital({
      name: 'City General Hospital',
      mrnPrefix: 'CGA',
      facilityType: 'allopathic',
    });

    sanjeevani = a.hospital.id;
    cityGeneral = b.hospital.id;

    const deskSanjeevani = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    const deskCityGeneral = await signIn(ctx, b.staff.frontDesk as SeededStaff);
    const vaidya = a.staff.clinician as SeededStaff;
    const clinicianB = b.staff.clinician as SeededStaff;
    const recordsB = b.staff.records as SeededStaff;

    gastroenterologist = await signIn(ctx, clinicianB);
    // Records staff stand in for the casualty doctor's colleague only for seeding;
    // emergency access itself is taken by a clinician.
    casualtyDoctor = await signIn(ctx, clinicianB);
    void recordsB;

    lakshmiId = (await post('/patients', deskSanjeevani, LAKSHMI)).body.patient.id;
    expect((await post('/patients', deskCityGeneral, LAKSHMI)).body.linkedExisting).toBe(true);

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    // Her record at Sanjeevani: the Amlapitta consultation of SP3, and the
    // liver panel and ultrasound of SP4.
    await asSystem(async (tx) => {
      await tx`UPDATE patient SET blood_group = 'B+' WHERE id = ${lakshmiId}`;

      const [visit] = await tx<Array<{ id: string }>>`
        INSERT INTO encounter (patient_id, hospital_id, class, system_of_medicine, attending_staff_id, recorded_by_staff_id, status, started_at, ended_at, chief_complaint)
        VALUES (${lakshmiId}, ${sanjeevani}, 'outpatient', 'ayurveda', ${vaidya.id}, ${vaidya.id}, 'finished',
                now() - interval '60 days', now() - interval '60 days' + interval '30 minutes',
                'Burning after meals for three months')
        RETURNING id
      `;

      const [condition] = await tx<Array<{ id: string }>>`
        INSERT INTO condition (patient_id, hospital_id, encounter_id, clinical_status, verification_status, is_primary, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${sanjeevani}, ${visit!.id}, 'active', 'confirmed', true, ${vaidya.id}, ${vaidya.id})
        RETURNING id
      `;
      await tx`
        INSERT INTO condition_coding (condition_id, role, code_system_key, code_system_version, code, display)
        VALUES (${condition!.id}, 'primary', 'NAMASTE', '2024', 'AYU-AMLAPITTA', 'Amlapitta')
      `;

      await tx`
        INSERT INTO medication_request (patient_id, hospital_id, encounter_id, system_of_medicine, medicine_name, strength, frequency, route, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${sanjeevani}, ${visit!.id}, 'ayurveda', 'Avipattikar churna', '5 g', '1-0-1', 'oral', ${vaidya.id}, ${vaidya.id})
      `;
      await tx`
        INSERT INTO allergy_intolerance (patient_id, hospital_id, encounter_id, substance, category, criticality, reaction, attributed_clinician_id, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${sanjeevani}, ${visit!.id}, 'Penicillin V', 'medication', 'high', 'Hives and facial swelling', ${vaidya.id}, ${vaidya.id})
      `;
      await tx`
        INSERT INTO observation (patient_id, hospital_id, encounter_id, category, source, code_system, code, display, value_quantity, unit, value_canonical, unit_canonical, reference_low, reference_high, interpretation, panel_code, group_id, effective_at, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${sanjeevani}, ${visit!.id}, 'laboratory', 'entered', 'http://loinc.org', '1742-6', 'Alanine aminotransferase', 62, 'U/L', 62, 'U/L', 7, 56, 'high', 'lft', gen_random_uuid(), now() - interval '55 days', ${vaidya.id})
      `;
      await tx`
        INSERT INTO document_reference (patient_id, hospital_id, encounter_id, doc_type, title, report_date, availability, availability_changed_at, recorded_by_staff_id)
        VALUES (${lakshmiId}, ${sanjeevani}, ${visit!.id}, 'radiology', 'Ultrasound abdomen', CURRENT_DATE - 50, 'available', now(), ${vaidya.id})
      `;
    });

    // 1. The front desk turns the portal on for her phone, with her in front of them.
    expect(
      (await post(`/patients/${lakshmiId}/portal-access`, deskSanjeevani, {
        phone: LAKSHMI.phone,
        identityConfirmed: true,
      })).status,
    ).toBe(201);

    gastroenterologistName = await asSystem(async (tx) => {
      const [row] = await tx<Array<{ name: string }>>`SELECT name FROM staff_user WHERE id = ${clinicianB.id}`;
      return row!.name;
    });
  }, 180_000);

  afterAll(async () => {
    await worker?.close();
    await closeOwner?.();
    await ctx?.close();
  });

  it('1. she signs in with a code and sees her own record, with no consent anywhere', async () => {
    const bearer = await signInToPortal();

    const summary = await get('/portal/summary', bearer);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.problems[0]).toMatchObject({ name: 'Amlapitta' });
    expect(summary.body.medicines[0]).toMatchObject({ name: 'Avipattikar churna 5 g' });
    expect(summary.body.allergies[0]).toMatchObject({ substance: 'Penicillin V', highRisk: true });
    expect(summary.body.abnormalResults[0]).toMatchObject({ label: 'ALT (SGPT)', value: 62 });

    expect((await get('/portal/documents', bearer)).body.results).toEqual([
      expect.objectContaining({ title: 'Ultrasound abdomen' }),
    ]);

    // Nothing above rested on a consent: it is her own record.
    expect((await get('/portal/consents', bearer)).body.consents).toEqual([]);
  });

  it('2. she shares four kinds of record with City General, for six months, but not her documents', async () => {
    const bearer = await signInToPortal();

    const granted = await post('/portal/consents', bearer, {
      hospitalId: cityGeneral,
      dataCategories: ['diagnoses', 'medications', 'allergies', 'observations'],
      validForDays: 180,
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect(granted.body).toMatchObject({ captureMethod: 'patient_portal', recordedBy: { kind: 'patient', you: true } });
    consentId = granted.body.id;
  });

  it('3. the gastroenterologist reads what she shared, and her history names him and the consent', async () => {
    expect(await sharedWithCityGeneral()).toEqual(['allergies', 'diagnoses', 'medications', 'observations']);

    const bearer = await signInToPortal();
    const history = (await get('/portal/access-history', bearer)).body.entries as HistoryEntry[];
    const hisRead = history.find(
      (entry) => entry.hospital?.id === cityGeneral && entry.resources.includes('timeline'),
    );

    expect(hisRead).toMatchObject({
      actor: { kind: 'staff', name: gastroenterologistName, role: 'clinician' },
      hospital: { name: 'City General Hospital' },
      consents: [expect.objectContaining({ captureMethod: 'patient_portal', grantedByYou: true })],
    });
  });

  it('4. she stops the sharing from her phone, and City General sees nothing of Sanjeevani', async () => {
    const bearer = await signInToPortal();

    const revoked = await post(`/portal/consents/${consentId}/revoke`, bearer);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', revokedBy: { kind: 'patient', you: true } });

    expect(await sharedWithCityGeneral()).toEqual([]);
  });

  it('5. a casualty doctor takes emergency access; she is texted, and her history says why', async () => {
    const taken = await post(`/patients/${lakshmiId}/break-glass`, casualtyDoctor, {
      reason: EMERGENCY_REASON,
      hours: 1,
    });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);

    // Emergency access reaches everything, documents included.
    expect(await sharedWithCityGeneral()).toContain('documents');

    const told = await (async () => {
      const until = Date.now() + 15_000;
      for (;;) {
        const message = sms.lastTo(`+91${LAKSHMI.phone}`);
        if (message?.template === 'break_glass') return message;
        if (Date.now() > until) throw new Error('No text message about emergency access');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();

    expect(told.body).toContain('City General Hospital');
    expect(told.body).not.toContain(EMERGENCY_REASON);

    const bearer = await signInToPortal();
    const alerts = await get('/portal/notifications', bearer);
    expect(alerts.body.emergencyAccesses).toEqual([
      expect.objectContaining({
        hospital: { id: cityGeneral, name: 'City General Hospital' },
        reason: EMERGENCY_REASON,
        active: true,
        notifiedAt: expect.any(String),
      }),
    ]);

    const history = (await get('/portal/access-history', bearer)).body.entries as HistoryEntry[];
    expect(history.some((entry) => entry.emergencyReason === EMERGENCY_REASON)).toBe(true);
  });

  it('6. her emergency card opens from its code without signing in, and the opening is in her history', async () => {
    const bearer = await signInToPortal();

    const card = await post('/portal/emergency-card', bearer, {
      fields: ['blood_group', 'allergies'],
    });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    cardToken = card.body.token;

    const page = await get(`/emergency/${cardToken}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.facts).toMatchObject({
      name: 'Lakshmi Amlapitta',
      bloodGroup: 'B+',
      allergies: [expect.objectContaining({ substance: 'Penicillin V', highRisk: true })],
    });

    const history = (await get('/portal/access-history', bearer)).body.entries as HistoryEntry[];
    expect(
      history.some((entry) => entry.actor.kind === 'system' && entry.resources.includes('emergency_card')),
    ).toBe(true);
  });

  it('7. she takes her whole record away, as a PDF and as FHIR', async () => {
    const bearer = await signInToPortal();

    const asked = await post('/portal/exports', bearer);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(await ctx.app.get(ExportBuilder).build(asked.body.id)).toBe('built');

    const ready = (await get('/portal/exports', bearer)).body[0];
    expect(ready).toMatchObject({ status: 'ready' });
    // A visit, a diagnosis, a medicine, an allergy, a result and a report.
    expect(ready.entryCount).toBe(6);

    const pdf = await get(`/portal/exports/${asked.body.id}/download?format=pdf`, bearer);
    expect(pdf.status, JSON.stringify(pdf.body)).toBe(200);
    expect(pdf.body.url).toContain('record.pdf');

    const fhir = await get(`/portal/exports/${asked.body.id}/download?format=fhir`, bearer);
    expect(fhir.body.url).toContain('record.fhir.json');
  });
});
