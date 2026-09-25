import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { LogSmsSender } from '../src/modules/portal/sms';
import { StorageService } from '../src/modules/storage/storage.service';
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

type Order = {
  id: string;
  status: string;
  priority: string;
  resultCount: number;
  requestedDisplay: string;
};

type Admission = {
  encounterId: string;
  bedDays: number;
  dischargedAt: string | null;
  currentBed: { id: string; label: string } | null;
  stays: Array<{ bed: string; endedAt: string | null; movedReason: string | null }>;
};

type Chargeable = {
  source: string;
  sourceId: string;
  description: string;
  quantity: number;
};

type Invoice = {
  id: string;
  number: string;
  totalPaise: number;
  settledPaise: number;
  outstandingPaise: number;
  standing: string;
  lines: Array<{ description: string; amountPaise: number }>;
  ledger: Array<{ kind: string; amountPaise: number }>;
  documentId: string | null;
};

type Summary = {
  id: string;
  status: string;
  sections: Array<{ key: string; text: string }>;
  documentId: string | null;
};

/**
 * The SP6 acceptance scenario (sp6-plan.md), a year on from SP5.
 *
 * Lakshmi comes back: a liver panel is ordered and resulted at City General,
 * she is admitted for a day-care procedure and moved once, a stent is recorded
 * by its serial number, her discharge summary is composed and signed and
 * reaches her phone, the desk bills her and takes the money in parts, and the
 * month's figures — the dues report, the revenue summary and the Ayush
 * morbidity return — agree with all of it.
 *
 * Time is not simulated. The plan's "two days later" and "a week later" are
 * the shape of the story rather than the clock: the stay is billed at whatever
 * bed-days it comes to, and the second payment follows the first immediately.
 */
describe('SP6 acceptance: Lakshmi, a year on', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;
  let sms: LogSmsSender;


  let vaidyaToken: string;
  let sanjeevaniDeskToken: string;
  let sanjeevaniAdminToken: string;
  let physicianToken: string;
  let cityDeskToken: string;
  let cityAdminToken: string;

  let lakshmiId: string;
  let encounterId: string;
  let orderId: string;
  let procedureId: string;
  let summaryId: string;
  let invoiceId: string;

  let dayCareBed: string;
  let generalBed: string;
  const price: Record<string, string> = {};

  const LAKSHMI = {
    name: 'Lakshmi Iyer',
    gender: 'female',
    dateOfBirth: '1968-04-12',
    phone: '9820099401',
  };

  const post = (path: string, bearer: string | null, body: Record<string, unknown> = {}) => {
    const request = ctx.http().post(`/api/v1${path}`);
    return (bearer ? request.set('Authorization', `Bearer ${bearer}`) : request).send(body);
  };

  const get = (path: string, bearer?: string) => {
    const request = ctx.http().get(`/api/v1${path}`);
    return bearer ? request.set('Authorization', `Bearer ${bearer}`) : request;
  };

  const istToday = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  /** As she does it on her phone: a code by SMS, then her own record. */
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

  beforeAll(async () => {
    await resetDatabase();
    await loadDemoTerminology();
    ctx = await createTestApp();
    sms = ctx.app.get(LogSmsSender);
    await ctx.app.get(StorageService).ensureBucket();

    const a = await seedHospital({ name: 'Sanjeevani Ayurvedic Hospital', mrnPrefix: 'SA6' });
    const b = await seedHospital({
      name: 'City General Hospital',
      mrnPrefix: 'CG6',
      facilityType: 'allopathic',
    });


    vaidyaToken = await signIn(ctx, a.staff.clinician as SeededStaff);
    sanjeevaniDeskToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    sanjeevaniAdminToken = await signIn(ctx, a.staff.admin as SeededStaff);
    physicianToken = await signIn(ctx, b.staff.clinician as SeededStaff);
    cityDeskToken = await signIn(ctx, b.staff.frontDesk as SeededStaff);
    cityAdminToken = await signIn(ctx, b.staff.admin as SeededStaff);

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;

    // She is registered at both hospitals — the second recognises her.
    lakshmiId = (await post('/patients', sanjeevaniDeskToken, LAKSHMI)).body.patient.id;
    expect((await post('/patients', cityDeskToken, LAKSHMI)).body.linkedExisting).toBe(true);

    // Her Amlapitta, recorded at Sanjeevani this month with both its codes —
    // which is what the ministry's return counts at the end of this test.
    const consultation = (await post('/encounters', vaidyaToken, { patientId: lakshmiId })).body.id;
    const diagnosed = await post('/diagnoses', vaidyaToken, {
      encounterId: consultation,
      code: 'DEMO-NAM-001',
    });
    expect(diagnosed.status, JSON.stringify(diagnosed.body)).toBe(201);

    // An older liver panel at Sanjeevani, for the trend to have a past.
    const earlier = await post('/results', vaidyaToken, {
      patientId: lakshmiId,
      encounterId: consultation,
      panel: 'lft',
      collectedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      results: [{ code: '1742-6', value: 62, unit: 'U/L', referenceLow: 7, referenceHigh: 56 }],
    });
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(201);

    // She shares her record with City General, and turns her portal on.
    const consent = await post(`/patients/${lakshmiId}/consents`, cityDeskToken, {
      dataCategories: [
        'encounters',
        'diagnoses',
        'medications',
        'observations',
        'procedures',
        'documents',
      ],
      validForDays: 30,
      captureMethod: 'signed_form',
    });
    expect(consent.status, JSON.stringify(consent.body)).toBe(201);

    expect(
      (
        await post(`/patients/${lakshmiId}/portal-access`, sanjeevaniDeskToken, {
          phone: LAKSHMI.phone,
          identityConfirmed: true,
        })
      ).status,
    ).toBe(201);

    // City General's price list, which is what she will be billed against.
    for (const item of [
      { code: 'BED-DAY', name: 'General ward bed', category: 'bed', unit: 'day', pricePaise: 120000 },
      { code: 'PROC-ERCP', name: 'Day-care endoscopic procedure', category: 'procedure', unit: 'each', pricePaise: 850000 },
      { code: 'LAB-LFT', name: 'Liver function panel', category: 'laboratory', unit: 'test', pricePaise: 60000 },
      { code: 'IMP-STENT', name: 'Biliary stent', category: 'consumable', unit: 'each', pricePaise: 450000 },
    ]) {
      const created = await post('/catalogue', cityAdminToken, item);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      price[item.code] = created.body.id as string;
    }

    // Its wards: a day-care bed and a general one.
    const dayCare = (
      await post('/wards', cityAdminToken, { name: 'Day care', kind: 'day_care', beds: ['D1'] })
    ).body;
    const general = (
      await post('/wards', cityAdminToken, { name: 'General ward', kind: 'general', beds: ['G1'] })
    ).body;

    dayCareBed = dayCare.beds[0].id as string;
    generalBed = general.beds[0].id as string;
  }, 300_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('1. the physician orders a liver panel, and the lab sees it outstanding', async () => {
    encounterId = (
      await post('/encounters', physicianToken, {
        patientId: lakshmiId,
        class: 'inpatient',
        chiefComplaint: 'Recurrent burning and one episode of jaundice',
      })
    ).body.id;

    const ordered = await post('/orders', physicianToken, {
      encounterId,
      category: 'laboratory',
      requestedDisplay: 'Liver function panel',
      requestedCodeSystem: 'http://loinc.org',
      requestedCode: '24325-3',
      priority: 'urgent',
      clinicalNote: 'Jaundice since Tuesday; check before the procedure',
    });
    expect(ordered.status, JSON.stringify(ordered.body)).toBe(201);

    const order = ordered.body as Order;
    orderId = order.id;
    expect(order).toMatchObject({ status: 'ordered', priority: 'urgent', resultCount: 0 });

    const worklist = await get('/orders?category=laboratory', cityDeskToken);
    expect(worklist.status).toBe(200);
    expect(
      (worklist.body.entries as Array<Order & { patient: { name: string } }>).map(
        (entry) => entry.id,
      ),
    ).toContain(orderId);
  });

  it('2. the lab collects and types the values, and her trend gains a point', async () => {
    const collected = await post(`/orders/${orderId}/advance`, cityDeskToken, {
      status: 'collected',
      reference: 'CG6-40881',
    });
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);

    const typed = await post('/results', physicianToken, {
      patientId: lakshmiId,
      encounterId,
      serviceRequestId: orderId,
      panel: 'lft',
      collectedAt: new Date(Date.now() - 3_600_000).toISOString(),
      results: [
        { code: '1742-6', value: 71, unit: 'U/L', referenceLow: 7, referenceHigh: 56 },
        { code: '1975-2', value: 1.4, unit: 'mg/dL', referenceLow: 0.2, referenceHigh: 1.2 },
      ],
    });
    expect(typed.status, JSON.stringify(typed.body)).toBe(201);

    const [after] = (await get(`/encounters/${encounterId}/orders`, physicianToken)).body.filter(
      (candidate: Order) => candidate.id === orderId,
    );
    expect(after).toMatchObject({ status: 'resulted', resultCount: 2 });

    // Beside the older one from Sanjeevani, under the consent she gave.
    const trend = await get(`/patients/${lakshmiId}/results/trends?code=1742-6`, physicianToken);
    expect(trend.status, JSON.stringify(trend.body)).toBe(200);

    const points = trend.body.points as Array<{ value: number; hospital: { isOwn: boolean } }>;
    expect(points.map((point) => point.hospital.isOwn)).toEqual([false, true]);
    expect(points.map((point) => point.value)).toEqual([62, 71]);
  });

  it('3. she is given a bed, moved once, and discharged; both beds are free after', async () => {
    const admitted = await post('/admissions', cityDeskToken, {
      encounterId,
      bedId: dayCareBed,
    });
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(201);
    expect((admitted.body as Admission).currentBed).toMatchObject({ label: 'D1' });

    const moved = await post(`/admissions/${encounterId}/transfer`, cityDeskToken, {
      bedId: generalBed,
      reason: 'Kept overnight for observation',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((moved.body as Admission).currentBed).toMatchObject({ label: 'G1' });
  });

  it('4. the procedure is recorded, with the stent that was left behind', async () => {
    const performed = await post('/procedures', physicianToken, {
      encounterId,
      name: 'ERCP with biliary stenting',
      performedAt: new Date(Date.now() - 5_400_000).toISOString(),
      preOpAssessment: 'Fasting since midnight. Consent taken. No allergy to contrast.',
      anaesthesia: 'Sedation',
      operativeNote:
        'Duodenoscope to the papilla. Cannulation at the second attempt. Distal stricture dilated and a 10 Fr stent placed. Bile drained freely.',
      postOpCourse: 'Comfortable. Eating by the evening.',
      outcome: 'Uncomplicated',
    });
    expect(performed.status, JSON.stringify(performed.body)).toBe(201);
    procedureId = performed.body.id as string;

    const implanted = await post('/implants', physicianToken, {
      encounterId,
      procedureId,
      name: 'Biliary stent',
      manufacturer: 'Meditech Implants',
      model: 'BS-10F',
      serialOrLot: 'SN-2026-77401',
      notes: '10 Fr, 7 cm, distal common bile duct',
    });
    expect(implanted.status, JSON.stringify(implanted.body)).toBe(201);

    // Found by its serial number, which is what a recall asks for.
    const found = await get('/implants?q=SN-2026-77401', physicianToken);
    expect(found.status).toBe(200);
    const carried = found.body.results as Array<{
      serialOrLot: string;
      procedureName: string;
      patient: { id: string; mrn: string | null };
    }>;

    expect(carried).toHaveLength(1);
    expect(carried[0]!.serialOrLot).toBe('SN-2026-77401');
    expect(carried[0]!.procedureName).toBe('ERCP with biliary stenting');
    expect(carried[0]!.patient.id).toBe(lakshmiId);
  });

  it('5. her discharge summary is composed, signed, and on her phone', async () => {
    const composed = await post('/discharge-summaries', physicianToken, { encounterId });
    expect(composed.status, JSON.stringify(composed.body)).toBe(201);

    const summary = composed.body as Summary;
    summaryId = summary.id;

    const textOf = (of: Summary, key: string) =>
      of.sections.find((section) => section.key === key)?.text ?? '';

    // Composed from the encounter's own record, and nothing else.
    expect(textOf(summary, 'admission')).toContain('General ward · G1');
    expect(textOf(summary, 'procedures')).toContain('ERCP with biliary stenting');
    expect(textOf(summary, 'procedures')).toContain('SN-2026-77401');
    expect(textOf(summary, 'investigations')).toContain('71 U/L');

    const edited = await post(`/discharge-summaries/${summaryId}`, physicianToken, {
      sections: [
        { key: 'condition', text: 'Comfortable, eating, jaundice settling.' },
        { key: 'advice', text: 'Return at once if the fever or the pain comes back.' },
        { key: 'follow_up', text: 'Review in four weeks with a repeat liver panel.' },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    const signed = await post(`/discharge-summaries/${summaryId}/sign`, physicianToken, {
      confirmed: true,
    });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toMatchObject({ status: 'signed' });
    expect(signed.body.documentId).toBeTruthy();

    // Discharged from the bed, which frees it and finishes the encounter.
    const discharged = await post(`/admissions/${encounterId}/discharge`, cityDeskToken, {
      note: 'Home, stent in place, review in four weeks',
    });
    expect(discharged.status, JSON.stringify(discharged.body)).toBe(200);

    const admission = discharged.body as Admission;
    expect(admission.currentBed).toBeNull();
    expect(admission.stays.map((stay) => stay.bed)).toEqual(['D1', 'G1']);
    expect(admission.stays.every((stay) => stay.endedAt !== null)).toBe(true);
    expect(admission.bedDays).toBeGreaterThanOrEqual(1);

    const board = await get('/wards', cityDeskToken);
    const beds = (board.body.wards as Array<{ beds: Array<{ label: string; occupant: unknown }> }>)
      .flatMap((ward) => ward.beds);
    expect(beds.every((bed) => bed.occupant === null)).toBe(true);

    // And on her phone that evening.
    const portalToken = await signInToPortal();
    const documents = await get('/portal/documents', portalToken);
    expect(documents.status, JSON.stringify(documents.body)).toBe(200);
    expect(
      (documents.body.results as Array<{ id: string; docType: string }>).some(
        (document) => document.id === signed.body.documentId,
      ),
    ).toBe(true);
  });

  it('6. the desk bills what was done, and takes the money in parts', async () => {
    const chargeable = (await get(`/encounters/${encounterId}/charges`, cityDeskToken)).body;
    const uncharged = chargeable.uncharged as Chargeable[];

    // One line per stay: the day-care bed she started in, and the ward she
    // was moved to. The desk charges both against the same bed-day price.
    const stays = uncharged.filter((row) => row.source === 'bed_day');
    const procedure = uncharged.find((row) => row.source === 'procedure')!;
    const order = uncharged.find((row) => row.source === 'order')!;

    expect(stays.map((stay) => stay.description.split(' · ')[1])).toEqual(['D1', 'G1']);
    expect(procedure.description).toContain('ERCP');

    const bedDayQuantity = stays.reduce((total, stay) => total + stay.quantity, 0);

    for (const [item, row] of [
      ...stays.map((stay) => [price['BED-DAY']!, stay] as [string, Chargeable]),
      [price['PROC-ERCP']!, procedure],
      [price['LAB-LFT']!, order],
    ] as Array<[string, Chargeable]>) {
      const captured = await post('/charges', cityDeskToken, {
        encounterId,
        itemId: item,
        quantity: row.quantity,
        source: row.source,
        sourceId: row.sourceId,
      });
      expect(captured.status, JSON.stringify(captured.body)).toBe(201);
    }

    // The stent is a consumable rather than something the record proposes.
    const stent = await post('/charges', cityDeskToken, {
      encounterId,
      itemId: price['IMP-STENT'],
      note: 'Biliary stent, SN-2026-77401',
    });
    expect(stent.status, JSON.stringify(stent.body)).toBe(201);

    // A duplicate the desk notices only after the invoice is raised.
    const duplicate = await post('/charges', cityDeskToken, {
      encounterId,
      itemId: price['LAB-LFT'],
      note: 'Entered twice',
    });
    expect(duplicate.status).toBe(201);

    const issued = await post('/invoices', cityDeskToken, { encounterId });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);

    const invoice = issued.body as Invoice;
    invoiceId = invoice.id;

    const expected = 120000 * bedDayQuantity + 850000 + 60000 + 450000 + 60000;

    expect(invoice.number).toMatch(/\/000001$/);
    expect(invoice.totalPaise).toBe(expected);
    expect(invoice.lines).toHaveLength(4 + stays.length);
    expect(invoice.documentId).toBeTruthy();

    // Half in cash, the rest by UPI.
    const half = Math.floor(invoice.totalPaise / 2);

    const first = await post(`/invoices/${invoiceId}/entries`, cityDeskToken, {
      kind: 'payment',
      method: 'cash',
      amountPaise: half,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ standing: 'part_paid' });

    const second = await post(`/invoices/${invoiceId}/entries`, cityDeskToken, {
      kind: 'payment',
      method: 'upi',
      amountPaise: invoice.totalPaise - half,
      reference: 'UPI-77401',
    });
    expect(second.body).toMatchObject({ outstandingPaise: 0, standing: 'settled' });

    // The duplicate panel is written off, which leaves her in credit.
    const credited = await post(`/invoices/${invoiceId}/entries`, cityDeskToken, {
      kind: 'credit_note',
      amountPaise: 60000,
      reason: 'The liver panel was charged twice',
    });
    expect(credited.status, JSON.stringify(credited.body)).toBe(400);

    // A credit note cannot exceed what is owed, so the money goes back first.
    const refunded = await post(`/invoices/${invoiceId}/entries`, cityDeskToken, {
      kind: 'refund',
      method: 'upi',
      amountPaise: 60000,
      note: 'The liver panel was charged twice',
    });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(201);

    const written = await post(`/invoices/${invoiceId}/entries`, cityDeskToken, {
      kind: 'credit_note',
      amountPaise: 60000,
      reason: 'The liver panel was charged twice',
    });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    expect(written.body).toMatchObject({ outstandingPaise: 0, standing: 'settled' });
  });

  it('7. the dues report and the month’s revenue agree with the ledger', async () => {
    const invoice = (await get(`/invoices/${invoiceId}`, cityDeskToken)).body as Invoice;

    // What has come off the total is the ledger's own arithmetic: money in,
    // less money given back, plus what was written off.
    const sum = (kind: string) =>
      invoice.ledger
        .filter((entry) => entry.kind === kind)
        .reduce((total, entry) => total + entry.amountPaise, 0);

    expect(invoice.settledPaise).toBe(sum('payment') - sum('refund') + sum('credit_note'));
    expect(invoice.outstandingPaise).toBe(invoice.totalPaise - invoice.settledPaise);
    expect(invoice.outstandingPaise).toBe(0);

    // Nothing is owed, so she is not in the dues list at all.
    const dues = await get('/invoices', cityDeskToken);
    expect((dues.body.invoices as Invoice[]).some((row) => row.id === invoiceId)).toBe(false);
    expect(dues.body.outstandingPaise).toBe(0);

    // And the month's revenue counts her invoice once.
    const from = `${istToday().slice(0, 7)}-01`;
    const revenue = await get(`/reports/revenue?from=${from}&to=${istToday()}`, cityAdminToken);
    expect(revenue.status, JSON.stringify(revenue.body)).toBe(200);
    expect(revenue.body.invoicedPaise).toBe(invoice.totalPaise);
    expect(revenue.body.receivedPaise).toBe(invoice.totalPaise - 60000);
    expect(revenue.body.creditedPaise).toBe(60000);
    expect(revenue.body.outstandingPaise).toBe(0);

    const byMethod = revenue.body.byMethod as Array<{ key: string; amountPaise: number }>;
    expect(byMethod.map((row) => row.key).sort()).toEqual(['cash', 'upi']);
  });

  it('8. the month’s Ayush morbidity return counts her Amlapitta, and keeps it', async () => {
    const from = `${istToday().slice(0, 7)}-01`;

    const generated = await post('/statutory-returns', sanjeevaniAdminToken, {
      from,
      to: istToday(),
    });
    expect(generated.status, JSON.stringify(generated.body)).toBe(201);

    const filed = generated.body as {
      id: string;
      total: number;
      rows: Array<{ namasteCode: string; icd11Code: string | null; total: number; female: number }>;
      submittedAt: string | null;
    };

    expect(filed.total).toBe(1);
    expect(filed.rows[0]).toMatchObject({
      namasteCode: 'DEMO-NAM-001',
      icd11Code: 'DEMO-TM2-01',
      total: 1,
      female: 1,
    });

    const submitted = await post(
      `/statutory-returns/${filed.id}/submit`,
      sanjeevaniAdminToken,
      { reference: 'AYUSH/2026/01192' },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    // What was sent stays as it was sent, whatever the record does next.
    const corrected = await post('/diagnoses', vaidyaToken, {
      encounterId: (await post('/encounters', vaidyaToken, { patientId: lakshmiId })).body.id,
      code: 'DEMO-NAM-002',
    });
    expect(corrected.status).toBe(201);

    const again = await get(`/statutory-returns/${filed.id}`, sanjeevaniAdminToken);
    expect(again.body.total).toBe(1);
    expect(again.body.reference).toBe('AYUSH/2026/01192');

    // City General, counting the same month, sees none of Sanjeevani's.
    const theirs = await post('/statutory-returns', cityAdminToken, { from, to: istToday() });
    expect(theirs.status).toBe(201);
    expect(theirs.body.total).toBe(0);
  });
});
