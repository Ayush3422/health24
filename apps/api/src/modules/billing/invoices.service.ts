import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  financialYearOf,
  type InsuranceScheme,
  type Invoice,
  type InvoiceInsurance,
  type InvoiceLine,
  type InvoiceList,
  type InvoiceListItem,
  type InvoicesQuery,
  type InvoiceStanding,
  type IssueInvoiceInput,
  type LedgerEntry,
  type LedgerKind,
  type PaymentMethod,
  type RecordInsuranceInput,
  type RecordPaymentInput,
} from '@health24/shared';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { blankToNull, istToday, toIso } from '../clinical/clinical-access';
import { documentFileKey } from '../storage/keys';
import { StorageService } from '../storage/storage.service';
import { buildInvoicePdf } from './invoice-pdf';

type InvoiceRow = {
  id: string;
  number: string;
  financial_year: string;
  encounter_id: string;
  patient_id: string;
  patient_name: string | null;
  mrn: string | null;
  hospital_id: string;
  issued_at: string | Date;
  issued_by_staff_id: string;
  issued_by_name: string | null;
  note: string | null;
  total_paise: string | number;
  /** Payments less refunds, plus credit notes: what has come off the total. */
  settled_paise: string | number;
  document_reference_id: string | null;
};

const INVOICE_SELECT = sql`
  SELECT v."id", v."number", v."financial_year", v."encounter_id", v."patient_id",
         p."name" AS patient_name, l."mrn", v."hospital_id", v."issued_at", v."issued_by_staff_id",
         s."name" AS issued_by_name, v."note", v."total_paise", v."document_reference_id",
         coalesce((
           SELECT sum(
                    CASE e."kind"
                      WHEN 'payment' THEN e."amount_paise"
                      WHEN 'refund' THEN -e."amount_paise"
                      ELSE e."amount_paise"
                    END
                  )
             FROM "payment_entry" e WHERE e."invoice_id" = v."id"
         ), 0) AS settled_paise
    FROM "invoice" v
    LEFT JOIN "patient" p ON p."id" = v."patient_id"
    LEFT JOIN "patient_hospital_link" l
           ON l."patient_id" = v."patient_id" AND l."hospital_id" = v."hospital_id"
    LEFT JOIN "staff_user" s ON s."id" = v."issued_by_staff_id"
`;

/**
 * Invoices and the money ledger (sp6-plan.md, Decision R1, DF4).
 *
 * An invoice is issued once, with a number that has no gaps, and is never
 * edited afterwards. What happens to it is a ledger: money paid, money
 * refunded, and a credit note when the hospital decides it will not be paid
 * for something. Nothing in the ledger is ever changed either — a mistake is
 * another entry.
 *
 * Nowhere is there a paid flag. What is outstanding is arithmetic over the
 * ledger, worked out when somebody asks.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /** Bills the charges captured on an encounter, and renders the PDF of it. */
  async issue(actor: Actor, input: IssueInvoiceInput, meta: RequestMeta): Promise<Invoice> {
    const hospitalId = requireHospital(actor);
    const financialYear = financialYearOf(istToday());

    const invoiceId = await this.db.asTenant(hospitalId, async (tx) => {
      const encounter = await this.requireOwnEncounter(tx, hospitalId, input.encounterId);

      const charges = await tx.execute<{
        id: string;
        code: string;
        name: string;
        quantity: number;
        unit_price_paise: string | number;
        amount_paise: string | number;
      }>(sql`
        SELECT c."id", i."code", i."name", c."quantity", c."unit_price_paise", c."amount_paise"
          FROM "charge" c
          JOIN "service_catalogue_item" i ON i."id" = c."item_id"
         WHERE c."encounter_id" = ${input.encounterId}::uuid
           AND c."status" = 'captured'
           ${
             input.chargeIds && input.chargeIds.length > 0
               ? sql`AND c."id" IN (${sql.join(
                   input.chargeIds.map((id) => sql`${id}::uuid`),
                   sql`, `,
                 )})`
               : sql``
           }
      ORDER BY c."captured_at" ASC
           FOR UPDATE OF c
      `);

      const lines = [...charges];

      if (lines.length === 0) {
        throw new BadRequestException('There is nothing captured on this encounter left to bill');
      }

      const total = lines.reduce((sum, line) => sum + Number(line.amount_paise), 0);

      // Gapless, and rolled back with the invoice if anything here fails.
      const [numbered] = await tx.execute<{ next_invoice_number: number }>(sql`
        SELECT app.next_invoice_number(${hospitalId}::uuid, ${financialYear}) AS next_invoice_number
      `);

      const number = `${financialYear}/${String(numbered!.next_invoice_number).padStart(6, '0')}`;

      const [invoice] = await tx.execute<{ id: string }>(sql`
        INSERT INTO "invoice"
          ("patient_id", "hospital_id", "encounter_id", "number", "financial_year", "total_paise",
           "note", "issued_by_staff_id")
        VALUES (${encounter.patientId}::uuid, ${hospitalId}::uuid, ${input.encounterId}::uuid,
                ${number}, ${financialYear}, ${total}, ${blankToNull(input.note)},
                ${actor.staffUserId}::uuid)
        RETURNING "id"
      `);

      for (const line of lines) {
        await tx.execute(sql`
          INSERT INTO "invoice_line"
            ("hospital_id", "invoice_id", "charge_id", "code", "description", "quantity",
             "unit_price_paise", "amount_paise")
          VALUES (${hospitalId}::uuid, ${invoice!.id}::uuid, ${line.id}::uuid, ${line.code},
                  ${line.name}, ${line.quantity}, ${Number(line.unit_price_paise)},
                  ${Number(line.amount_paise)})
        `);

        await tx.execute(sql`
          UPDATE "charge" SET "status" = 'invoiced', "invoice_id" = ${invoice!.id}::uuid
           WHERE "id" = ${line.id}::uuid
        `);
      }

      return invoice!.id;
    });

    await this.render(actor, hospitalId, invoiceId, meta);

    await this.audit.recordForActor(actor, {
      resourceType: 'invoice',
      resourceId: invoiceId,
      patientId: null,
      action: 'create',
      meta,
    });

    return this.findById(actor, invoiceId, meta, { skipAudit: true });
  }

  /** Money in, money back, or an amount the hospital writes off. */
  async record(
    actor: Actor,
    invoiceId: string,
    input: RecordPaymentInput,
    meta: RequestMeta,
  ): Promise<Invoice> {
    const hospitalId = requireHospital(actor);

    await this.db.asTenant(hospitalId, async (tx) => {
      const invoice = await this.load(tx, invoiceId);

      if (input.kind === 'credit_note') {
        const outstanding = Number(invoice.total_paise) - Number(invoice.settled_paise);

        if (input.amountPaise > outstanding) {
          throw new BadRequestException(
            'A credit note cannot be for more than the invoice still owes',
          );
        }
      }

      await tx.execute(sql`
        INSERT INTO "payment_entry"
          ("hospital_id", "invoice_id", "kind", "method", "amount_paise", "reference", "note",
           "taken_by_staff_id")
        VALUES (${hospitalId}::uuid, ${invoiceId}::uuid, ${input.kind}::ledger_kind,
                ${input.method ?? null}::payment_method, ${input.amountPaise},
                ${blankToNull(input.reference)},
                ${blankToNull(input.kind === 'credit_note' ? input.reason : input.note)},
                ${actor.staffUserId}::uuid)
      `);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'payment_entry',
      resourceId: invoiceId,
      patientId: null,
      action: 'create',
      meta,
    });

    return this.findById(actor, invoiceId, meta, { skipAudit: true });
  }

  /** What is being claimed from a scheme, and what it says it will pay. */
  async recordInsurance(
    actor: Actor,
    invoiceId: string,
    input: RecordInsuranceInput,
    meta: RequestMeta,
  ): Promise<Invoice> {
    const hospitalId = requireHospital(actor);

    await this.db.asTenant(hospitalId, async (tx) => {
      await this.load(tx, invoiceId);

      await tx.execute(sql`
        INSERT INTO "invoice_insurance"
          ("hospital_id", "invoice_id", "scheme", "insurer", "policy_or_card", "approved_paise",
           "recorded_by_staff_id")
        VALUES (${hospitalId}::uuid, ${invoiceId}::uuid, ${input.scheme}::insurance_scheme,
                ${blankToNull(input.insurer)}, ${blankToNull(input.policyOrCard)},
                ${input.approvedPaise ?? null}, ${actor.staffUserId}::uuid)
      `);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'invoice_insurance',
      resourceId: invoiceId,
      patientId: null,
      action: 'create',
      meta,
    });

    return this.findById(actor, invoiceId, meta, { skipAudit: true });
  }

  async findById(
    actor: Actor,
    invoiceId: string,
    meta: RequestMeta,
    options: { skipAudit?: boolean } = {},
  ): Promise<Invoice> {
    const hospitalId = requireHospital(actor);

    const { row, lines, ledger, insurance } = await this.db.asTenant(hospitalId, async (tx) => {
      const found = await this.load(tx, invoiceId);

      const lineRows = await tx.execute<{
        id: string;
        charge_id: string;
        code: string;
        description: string;
        quantity: number;
        unit_price_paise: string | number;
        amount_paise: string | number;
      }>(sql`
        SELECT "id", "charge_id", "code", "description", "quantity", "unit_price_paise",
               "amount_paise"
          FROM "invoice_line" WHERE "invoice_id" = ${invoiceId}::uuid ORDER BY "code"
      `);

      const ledgerRows = await tx.execute<{
        id: string;
        kind: LedgerKind;
        method: PaymentMethod | null;
        amount_paise: string | number;
        reference: string | null;
        note: string | null;
        at: string | Date;
        taken_by_staff_id: string;
        taken_by_name: string | null;
      }>(sql`
        SELECT e."id", e."kind", e."method", e."amount_paise", e."reference", e."note", e."at",
               e."taken_by_staff_id", s."name" AS taken_by_name
          FROM "payment_entry" e
          LEFT JOIN "staff_user" s ON s."id" = e."taken_by_staff_id"
         WHERE e."invoice_id" = ${invoiceId}::uuid
      ORDER BY e."at" ASC
      `);

      const insuranceRows = await tx.execute<{
        id: string;
        scheme: InsuranceScheme;
        insurer: string | null;
        policy_or_card: string | null;
        approved_paise: string | number | null;
        recorded_at: string | Date;
        recorded_by_staff_id: string;
        recorded_by_name: string | null;
      }>(sql`
        SELECT i."id", i."scheme", i."insurer", i."policy_or_card", i."approved_paise",
               i."recorded_at", i."recorded_by_staff_id", s."name" AS recorded_by_name
          FROM "invoice_insurance" i
          LEFT JOIN "staff_user" s ON s."id" = i."recorded_by_staff_id"
         WHERE i."invoice_id" = ${invoiceId}::uuid
      ORDER BY i."recorded_at" ASC
      `);

      return {
        row: found,
        lines: [...lineRows].map((line): InvoiceLine => ({
          id: line.id,
          chargeId: line.charge_id,
          code: line.code,
          description: line.description,
          quantity: line.quantity,
          unitPricePaise: Number(line.unit_price_paise),
          amountPaise: Number(line.amount_paise),
        })),
        ledger: [...ledgerRows].map((entry): LedgerEntry => ({
          id: entry.id,
          kind: entry.kind,
          method: entry.method,
          amountPaise: Number(entry.amount_paise),
          reference: entry.reference,
          note: entry.note,
          at: toIso(entry.at),
          takenBy: { id: entry.taken_by_staff_id, name: entry.taken_by_name },
        })),
        insurance: [...insuranceRows].map((claim): InvoiceInsurance => ({
          id: claim.id,
          scheme: claim.scheme,
          insurer: claim.insurer,
          policyOrCard: claim.policy_or_card,
          approvedPaise: claim.approved_paise === null ? null : Number(claim.approved_paise),
          recordedAt: toIso(claim.recorded_at),
          recordedBy: { id: claim.recorded_by_staff_id, name: claim.recorded_by_name },
        })),
      };
    });

    if (!options.skipAudit) {
      await this.audit.recordForActor(actor, {
        resourceType: 'invoice',
        resourceId: invoiceId,
        patientId: null,
        action: 'read',
        meta,
      });
    }

    return { ...this.toListItem(row), lines, ledger, insurance };
  }

  /** What the hospital is still owed, or everything it has billed. */
  async list(actor: Actor, query: InvoicesQuery, meta: RequestMeta): Promise<InvoiceList> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<InvoiceRow>(sql`
        SELECT * FROM (${INVOICE_SELECT} WHERE v."hospital_id" = ${hospitalId}::uuid) AS billed
         WHERE ${
           query.scope === 'outstanding'
             ? sql`billed."total_paise" > billed."settled_paise"`
             : sql`true`
         }
           ${query.patientId ? sql`AND billed."patient_id" = ${query.patientId}::uuid` : sql``}
           ${
             query.financialYear ? sql`AND billed."financial_year" = ${query.financialYear}` : sql``
           }
      ORDER BY billed."issued_at" DESC
         LIMIT ${query.limit}
      `),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'invoice',
      resourceId: null,
      patientId: query.patientId ?? null,
      action: 'search',
      meta,
    });

    const invoices = [...rows].map((row) => this.toListItem(row));

    return {
      invoices,
      outstandingPaise: invoices.reduce(
        (total, invoice) => total + Math.max(0, invoice.outstandingPaise),
        0,
      ),
    };
  }

  /**
   * The invoice as a PDF in the patient's own reports (DF8).
   *
   * Rendered once, when the invoice is issued, and marked clean without a
   * scan: the server made it from the record a moment ago and it never left
   * the process.
   */
  private async render(
    actor: Actor,
    hospitalId: string,
    invoiceId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const invoice = await this.findById(actor, invoiceId, meta, { skipAudit: true });

    const [hospital] = await this.db.asTenant(hospitalId, (tx) =>
      tx.execute<{ name: string | null }>(sql`
        SELECT "name" FROM "hospital_directory" WHERE "id" = ${hospitalId}::uuid
      `),
    );

    const pdf = await buildInvoicePdf(invoice, hospital?.name ?? 'This hospital');
    const documentId = randomUUID();
    const fileId = randomUUID();
    const key = documentFileKey({
      hospitalId,
      patientId: invoice.patientId,
      documentId,
      fileId,
    });

    await this.storage.put(key, pdf, 'application/pdf');

    await this.db.asTenant(hospitalId, async (tx) => {
      const now = new Date().toISOString();
      const sha256 = createHash('sha256').update(pdf).digest('hex');

      await tx.execute(sql`
        INSERT INTO "document_reference"
          ("id", "patient_id", "hospital_id", "encounter_id", "doc_type", "title", "report_date",
           "availability", "availability_changed_at", "upload_confirmed_at", "recorded_by_staff_id",
           "recorded_at")
        VALUES (${documentId}::uuid, ${invoice.patientId}::uuid, ${hospitalId}::uuid,
                ${invoice.encounterId}::uuid, 'bill_or_receipt', ${`Invoice ${invoice.number}`},
                app.ist_date(${now}::timestamptz), 'available', ${now}::timestamptz,
                ${now}::timestamptz, ${actor.staffUserId}::uuid, ${now}::timestamptz)
      `);

      await tx.execute(sql`
        INSERT INTO "document_file"
          ("id", "document_id", "patient_id", "hospital_id", "position", "storage_key", "mime_type",
           "size_bytes", "sha256", "scan_status", "scanned_at")
        VALUES (${fileId}::uuid, ${documentId}::uuid, ${invoice.patientId}::uuid,
                ${hospitalId}::uuid, 1, ${key}, 'application/pdf', ${pdf.byteLength}, ${sha256},
                'clean', ${now}::timestamptz)
      `);

      await tx.execute(sql`
        UPDATE "invoice" SET "document_reference_id" = ${documentId}::uuid
         WHERE "id" = ${invoiceId}::uuid
      `);
    });
  }

  private async requireOwnEncounter(
    tx: DbTransaction,
    hospitalId: string,
    encounterId: string,
  ): Promise<{ patientId: string }> {
    const [encounter] = await tx.execute<{
      patient_id: string;
      hospital_id: string;
      status: string;
    }>(sql`
      SELECT "patient_id", "hospital_id", "status"::text AS status FROM "encounter"
       WHERE "id" = ${encounterId}::uuid
    `);

    if (!encounter || encounter.hospital_id !== hospitalId) {
      throw new NotFoundException('Encounter not found');
    }

    if (encounter.status === 'cancelled') {
      throw new ConflictException('That encounter was cancelled; nothing is billed against it');
    }

    return { patientId: encounter.patient_id };
  }

  private async load(tx: DbTransaction, invoiceId: string): Promise<InvoiceRow> {
    const [row] = await tx.execute<InvoiceRow>(sql`
      ${INVOICE_SELECT} WHERE v."id" = ${invoiceId}::uuid
    `);

    if (!row) throw new NotFoundException('Invoice not found');

    return row;
  }

  private toListItem(row: InvoiceRow): InvoiceListItem {
    const total = Number(row.total_paise);
    const settled = Number(row.settled_paise);
    const outstanding = total - settled;

    const standing: InvoiceStanding =
      outstanding <= 0
        ? outstanding < 0
          ? 'overpaid'
          : 'settled'
        : settled > 0
          ? 'part_paid'
          : 'unpaid';

    return {
      id: row.id,
      number: row.number,
      financialYear: row.financial_year,
      encounterId: row.encounter_id,
      patientId: row.patient_id,
      patientName: row.patient_name ?? 'A patient',
      mrn: row.mrn,
      issuedAt: toIso(row.issued_at),
      issuedBy: { id: row.issued_by_staff_id, name: row.issued_by_name },
      note: row.note,
      totalPaise: total,
      settledPaise: settled,
      outstandingPaise: outstanding,
      standing,
      documentId: row.document_reference_id,
    };
  }
}
