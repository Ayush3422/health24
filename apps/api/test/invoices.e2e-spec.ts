import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { financialYearOf } from '@health24/shared';
import { StorageService } from '../src/modules/storage/storage.service';
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

type Invoice = {
  id: string;
  number: string;
  financialYear: string;
  totalPaise: number;
  settledPaise: number;
  outstandingPaise: number;
  standing: string;
  lines: Array<{ code: string; amountPaise: number }>;
  ledger: Array<{ kind: string; method: string | null; amountPaise: number; note: string | null }>;
  insurance: Array<{ scheme: string; approvedPaise: number | null }>;
  documentId: string | null;
};

/**
 * Invoices and the money ledger (sp6-plan.md, Phase 7, DF4): a gapless number,
 * an invoice that is never edited, and a ledger that is only added to.
 */
describe('invoices and the money ledger', () => {
  let ctx: TestContext;
  let owner: postgres.Sql;
  let closeOwner: () => Promise<void>;

  let hospitalId: string;
  let adminToken: string;
  let deskToken: string;
  let clinicianToken: string;
  let otherAdminToken: string;

  let patientId: string;
  let encounterId: string;
  let consultationId: string;
  let dressingId: string;

  const post = (path: string, bearer: string, body: Record<string, unknown> = {}) =>
    ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`).send(body);

  const get = (path: string, bearer: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${bearer}`);

  const capture = (itemId: string, quantity = 1) =>
    post('/charges', deskToken, { encounterId, itemId, quantity });

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    await ctx.app.get(StorageService).ensureBucket();

    const a = await seedHospital({ name: 'Sanjeevani Invoice Test', mrnPrefix: 'SIT' });
    const b = await seedHospital({
      name: 'City General Invoice Test',
      mrnPrefix: 'CGI',
      facilityType: 'allopathic',
    });

    hospitalId = a.hospital.id;
    adminToken = await signIn(ctx, a.staff.admin as SeededStaff);
    deskToken = await signIn(ctx, a.staff.frontDesk as SeededStaff);
    clinicianToken = await signIn(ctx, a.staff.clinician as SeededStaff);
    otherAdminToken = await signIn(ctx, b.staff.admin as SeededStaff);

    patientId = (
      await post('/patients', deskToken, {
        name: 'Invoiced Patient',
        gender: 'female',
        dateOfBirth: '1971-08-14',
        phone: '9820110001',
      })
    ).body.patient.id;

    encounterId = (await post('/encounters', clinicianToken, { patientId })).body.id;

    consultationId = (
      await post('/catalogue', adminToken, {
        code: 'OPD-GEN',
        name: 'General consultation',
        category: 'consultation',
        unit: 'visit',
        pricePaise: 30000,
      })
    ).body.id;

    dressingId = (
      await post('/catalogue', adminToken, {
        code: 'PROC-DRESS',
        name: 'Dressing',
        category: 'procedure',
        unit: 'each',
        pricePaise: 15050,
      })
    ).body.id;

    const connection = testDb();
    owner = connection.client;
    closeOwner = connection.close;
  }, 180_000);

  afterAll(async () => {
    await closeOwner?.();
    await ctx?.close();
  });

  it('bills what was captured, with a number and a PDF for the patient', async () => {
    await capture(consultationId);
    await capture(dressingId, 2);

    const issued = await post('/invoices', deskToken, { encounterId });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);

    const invoice = issued.body as Invoice;

    expect(invoice.number).toMatch(/^\d{4}-\d{2}\/000001$/);
    expect(invoice.financialYear).toBe(financialYearOf(new Date().toISOString().slice(0, 10)));
    // ₹300 + 2 × ₹150.50 = ₹601.00
    expect(invoice.totalPaise).toBe(30000 + 2 * 15050);
    expect(invoice.lines).toHaveLength(2);
    expect(invoice).toMatchObject({ standing: 'unpaid', settledPaise: 0 });

    // The charges are the invoice's now, and cannot be voided behind its back.
    const charges = (await get(`/encounters/${encounterId}/charges`, deskToken)).body;
    expect(
      charges.charges.every((charge: { status: string }) => charge.status === 'invoiced'),
    ).toBe(true);
    expect(charges.invoicedPaise).toBe(invoice.totalPaise);

    const [firstCharge] = charges.charges;
    expect(
      (await post(`/charges/${firstCharge.id}/void`, deskToken, { reason: 'Too late' })).status,
    ).toBe(409);

    // The PDF is in the patient's own reports (DF8).
    expect(invoice.documentId).toBeTruthy();
    const documents = await get(`/patients/${patientId}/documents`, clinicianToken);
    expect(
      documents.body.results.find((row: { id: string }) => row.id === invoice.documentId),
    ).toMatchObject({ docType: 'bill_or_receipt', availability: 'available' });
  });

  it('refuses a second invoice when there is nothing left to bill', async () => {
    const empty = await post('/invoices', deskToken, { encounterId });
    expect(empty.status, JSON.stringify(empty.body)).toBe(400);
  });

  it('numbers without gaps, in order', async () => {
    const second = (await post('/encounters', clinicianToken, { patientId })).body.id;
    await post('/charges', deskToken, { encounterId: second, itemId: consultationId });

    const issued = await post('/invoices', deskToken, { encounterId: second });
    expect(issued.body.number).toMatch(/\/000002$/);

    const numbers = await owner<Array<{ number: string }>>`
      SELECT number FROM invoice ORDER BY number
    `;
    expect(numbers.map((row) => row.number.split('/')[1])).toEqual(['000001', '000002']);
  });

  it('takes money in parts, and says what is still owed after each', async () => {
    const [invoice] = (await get('/invoices?scope=all', deskToken)).body.invoices as Invoice[];

    const half = Math.floor(invoice.totalPaise / 2);

    const first = await post(`/invoices/${invoice.id}/entries`, deskToken, {
      kind: 'payment',
      method: 'cash',
      amountPaise: half,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      settledPaise: half,
      outstandingPaise: invoice.totalPaise - half,
      standing: 'part_paid',
    });

    const rest = await post(`/invoices/${invoice.id}/entries`, deskToken, {
      kind: 'payment',
      method: 'upi',
      amountPaise: invoice.totalPaise - half,
      reference: 'UPI-8842',
    });
    expect(rest.body).toMatchObject({ outstandingPaise: 0, standing: 'settled' });
    expect(rest.body.ledger).toHaveLength(2);
  });

  it('a refund puts the money back on the bill, and a credit note takes it off', async () => {
    const invoices = (await get('/invoices?scope=all', deskToken)).body.invoices as Invoice[];
    const settled = invoices.find((invoice) => invoice.standing === 'settled')!;

    const refunded = await post(`/invoices/${settled.id}/entries`, deskToken, {
      kind: 'refund',
      method: 'cash',
      amountPaise: 10000,
      note: 'Paid twice at the desk',
    });
    expect(refunded.status).toBe(201);
    expect(refunded.body).toMatchObject({ outstandingPaise: 10000, standing: 'part_paid' });

    const credited = await post(`/invoices/${settled.id}/entries`, deskToken, {
      kind: 'credit_note',
      amountPaise: 10000,
      reason: 'Dressing was charged twice; written off',
    });
    expect(credited.status, JSON.stringify(credited.body)).toBe(201);
    expect(credited.body).toMatchObject({ outstandingPaise: 0, standing: 'settled' });

    // A credit note moves no money, so it carries no method…
    const withMethod = await post(`/invoices/${settled.id}/entries`, deskToken, {
      kind: 'credit_note',
      method: 'cash',
      amountPaise: 100,
      reason: 'Should be refused',
    });
    expect(withMethod.status).toBe(400);

    // …and cannot be for more than is still owed.
    const tooMuch = await post(`/invoices/${settled.id}/entries`, deskToken, {
      kind: 'credit_note',
      amountPaise: 100000,
      reason: 'Should be refused',
    });
    expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBe(400);
  });

  it('records what a scheme was claimed for, and what it approved', async () => {
    const [invoice] = (await get('/invoices?scope=all', deskToken)).body.invoices as Invoice[];

    const claimed = await post(`/invoices/${invoice.id}/insurance`, deskToken, {
      scheme: 'pmjay',
      policyOrCard: 'PMJAY-4417-8890',
    });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(201);

    const approved = await post(`/invoices/${invoice.id}/insurance`, deskToken, {
      scheme: 'pmjay',
      policyOrCard: 'PMJAY-4417-8890',
      approvedPaise: 25000,
    });
    expect(approved.body.insurance).toHaveLength(2);
    expect(approved.body.insurance[1]).toMatchObject({ scheme: 'pmjay', approvedPaise: 25000 });
  });

  it('shows what the hospital is still owed', async () => {
    const outstanding = await get('/invoices', adminToken);
    expect(outstanding.status).toBe(200);

    const invoices = outstanding.body.invoices as Invoice[];
    expect(invoices.every((invoice) => invoice.outstandingPaise > 0)).toBe(true);
    expect(outstanding.body.outstandingPaise).toBe(
      invoices.reduce((total, invoice) => total + invoice.outstandingPaise, 0),
    );
  });

  it('is the hospital’s own, and a clinician has no business in it', async () => {
    expect((await get('/invoices?scope=all', otherAdminToken)).body.invoices).toEqual([]);
    expect((await get('/invoices', clinicianToken)).status).toBe(403);
  });

  it('in the database, is never edited, never deleted, and always adds up', async () => {
    const [invoice] = (await get('/invoices?scope=all', deskToken)).body.invoices as Invoice[];
    const { client: app, close } = appRoleDb();

    try {
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`UPDATE invoice SET total_paise = 1 WHERE id = ${invoice!.id}`;
        }),
      ).rejects.toThrow(/permission denied|immutable/);

      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`DELETE FROM invoice WHERE id = ${invoice!.id}`;
        }),
      ).rejects.toThrow(/permission denied|never deleted/);

      // The ledger is added to and never changed.
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`UPDATE payment_entry SET amount_paise = 1 WHERE invoice_id = ${invoice!.id}`;
        }),
      ).rejects.toThrow(/permission denied|immutable/);
    } finally {
      await close();
    }

    // The counter behind the numbering only counts forward, and is never
    // removed: either would hand a second invoice a number already issued.
    const counter = appRoleDb();

    try {
      await expect(
        counter.client.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`UPDATE invoice_number_series SET next_number = 1
                    WHERE hospital_id = ${hospitalId}`;
        }),
      ).rejects.toThrow(/permission denied|only counts forward/);

      await expect(
        counter.client.begin(async (tx) => {
          await tx`SELECT set_config('app.current_hospital_id', ${hospitalId}, true)`;
          await tx`DELETE FROM invoice_number_series WHERE hospital_id = ${hospitalId}`;
        }),
      ).rejects.toThrow(/permission denied|never deleted/);
    } finally {
      await counter.close();
    }

    // And an invoice whose lines do not come to its total is refused, in the
    // owner's own connection, where row-level security is not even in the way.
    await expect(
      owner.begin(async (tx) => {
        await tx`SELECT set_config('app.system_context', 'on', true)`;
        await tx`
          INSERT INTO invoice (patient_id, hospital_id, encounter_id, number, financial_year,
                               total_paise, issued_by_staff_id)
          SELECT patient_id, hospital_id, encounter_id, 'BOGUS/1', financial_year, 999999,
                 issued_by_staff_id
            FROM invoice WHERE id = ${invoice!.id}
        `;
      }),
    ).rejects.toThrow(/but its lines come to/);
  });
});
