import { z } from 'zod';
import {
  INSURANCE_SCHEMES,
  LEDGER_KINDS,
  PAYMENT_METHODS,
  type InsuranceScheme,
  type LedgerKind,
  type PaymentMethod,
} from '../enums.js';
import { uuidSchema } from '../primitives.js';
import { clinicalReasonSchema, staffRefSchema } from './clinical.js';
import { paiseSchema } from './billing.js';

/**
 * Invoices and the money ledger (sp6-plan.md, Decision R1, DF4).
 *
 * An invoice is never edited. It is issued with a gapless number, and what
 * happens to it afterwards is a ledger of entries that are added and never
 * changed: money paid, money refunded, and a credit note when the hospital
 * decides it will not be paid for something after all.
 *
 * There is no stored "paid" flag anywhere. What is outstanding is arithmetic
 * over the ledger, computed when somebody asks, so a status and a ledger can
 * never disagree.
 */

/** The financial year an invoice belongs to, as India counts it: 2026-27. */
export const financialYearOf = (isoDate: string): string => {
  const [year, month] = isoDate.split('-').map(Number);
  const start = (month ?? 1) >= 4 ? year! : year! - 1;

  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = {
  payment: 'Payment',
  refund: 'Refund',
  credit_note: 'Credit note',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  scheme: 'Scheme or insurer',
};

export const INSURANCE_SCHEME_LABELS: Record<InsuranceScheme, string> = {
  pmjay: 'PM-JAY',
  state_scheme: 'State scheme',
  private: 'Private insurer',
  employer: 'Employer',
};

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

export const issueInvoiceSchema = z.object({
  encounterId: uuidSchema,
  /**
   * The charges to bill. Left out, every charge captured on the encounter and
   * not yet invoiced — which is what the desk means nine times in ten.
   */
  chargeIds: z.array(uuidSchema).max(500).optional(),
  note: z.string().trim().max(500).optional(),
});
export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;

export const invoiceLineSchema = z.object({
  id: uuidSchema,
  chargeId: uuidSchema,
  code: z.string(),
  description: z.string(),
  quantity: z.number().int(),
  unitPricePaise: z.number().int(),
  amountPaise: z.number().int(),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const ledgerEntrySchema = z.object({
  id: uuidSchema,
  kind: z.enum(LEDGER_KINDS),
  method: z.enum(PAYMENT_METHODS).nullable(),
  amountPaise: z.number().int(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  at: z.string(),
  takenBy: staffRefSchema,
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const invoiceInsuranceSchema = z.object({
  id: uuidSchema,
  scheme: z.enum(INSURANCE_SCHEMES),
  insurer: z.string().nullable(),
  policyOrCard: z.string().nullable(),
  /** What the scheme says it will pay. Captured; never adjudicated here. */
  approvedPaise: z.number().int().nullable(),
  recordedAt: z.string(),
  recordedBy: staffRefSchema,
});
export type InvoiceInsurance = z.infer<typeof invoiceInsuranceSchema>;

/** Where an invoice stands, as arithmetic over the ledger — never a column. */
export const INVOICE_STANDINGS = ['unpaid', 'part_paid', 'settled', 'overpaid'] as const;
export type InvoiceStanding = (typeof INVOICE_STANDINGS)[number];

export const invoiceSchema = z.object({
  id: uuidSchema,
  number: z.string(),
  financialYear: z.string(),
  encounterId: uuidSchema,
  patientId: uuidSchema,
  patientName: z.string(),
  mrn: z.string().nullable(),
  issuedAt: z.string(),
  issuedBy: staffRefSchema,
  note: z.string().nullable(),
  totalPaise: z.number().int(),
  /** Paid minus refunded, plus credit notes: what has come off the total. */
  settledPaise: z.number().int(),
  outstandingPaise: z.number().int(),
  standing: z.enum(INVOICE_STANDINGS),
  lines: z.array(invoiceLineSchema),
  ledger: z.array(ledgerEntrySchema),
  insurance: z.array(invoiceInsuranceSchema),
  /** The PDF of it, in the patient's own reports (DF8). */
  documentId: uuidSchema.nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const invoiceListItemSchema = invoiceSchema.omit({
  lines: true,
  ledger: true,
  insurance: true,
});
export type InvoiceListItem = z.infer<typeof invoiceListItemSchema>;

export const invoicesQuerySchema = z.object({
  /** Outstanding by default: what the hospital is still owed. */
  scope: z.enum(['outstanding', 'all']).default('outstanding'),
  patientId: uuidSchema.optional(),
  financialYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type InvoicesQuery = z.infer<typeof invoicesQuerySchema>;

export const invoiceListSchema = z.object({
  invoices: z.array(invoiceListItemSchema),
  /** Everything still owed across the list, added up. */
  outstandingPaise: z.number().int(),
});
export type InvoiceList = z.infer<typeof invoiceListSchema>;

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export const recordPaymentSchema = z
  .object({
    kind: z.enum(LEDGER_KINDS).default('payment'),
    /** Cash, UPI, card, a transfer, or a scheme. A credit note moves no money. */
    method: z.enum(PAYMENT_METHODS).optional(),
    amountPaise: paiseSchema.refine((value) => value > 0, 'An entry is for some amount'),
    /** The UPI reference, the card's last four, the scheme's claim number. */
    reference: z.string().trim().max(120).optional(),
    note: z.string().trim().max(500).optional(),
    /** Required for a credit note: why the hospital is writing it off. */
    reason: clinicalReasonSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.kind === 'credit_note') {
      if (entry.method) {
        ctx.addIssue({
          code: 'custom',
          path: ['method'],
          message: 'A credit note moves no money, so it has no method',
        });
      }

      if (!entry.reason) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'Say why the invoice is being credited',
        });
      }

      return;
    }

    if (!entry.method) {
      ctx.addIssue({ code: 'custom', path: ['method'], message: 'Say how the money moved' });
    }
  });
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const recordInsuranceSchema = z.object({
  scheme: z.enum(INSURANCE_SCHEMES),
  insurer: z.string().trim().max(200).optional(),
  policyOrCard: z.string().trim().max(120).optional(),
  approvedPaise: paiseSchema.optional(),
});
export type RecordInsuranceInput = z.infer<typeof recordInsuranceSchema>;
