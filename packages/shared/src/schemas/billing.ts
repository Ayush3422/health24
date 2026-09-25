import { z } from 'zod';
import {
  CATALOGUE_CATEGORIES,
  CHARGE_SOURCES,
  CHARGE_STATUSES,
  type CatalogueCategory,
} from '../enums.js';
import { uuidSchema } from '../primitives.js';
import { clinicalReasonSchema, staffRefSchema } from './clinical.js';

/**
 * The service catalogue and what a patient is charged (sp6-plan.md, R1).
 *
 * Money is integer paise everywhere: in the database, in this contract, and in
 * both apps (DF3). Rupees appear only where a person reads them, and they are
 * made from paise at that moment — never stored, never added up, never the
 * thing a total is computed from. Floating-point rupees are wrong by design,
 * and the error compounds through part-payments and refunds.
 */

/** A price, in paise. ₹1,250.00 is 125000. */
export const paiseSchema = z
  .number()
  .int('Money is counted in whole paise')
  .min(0, 'A price cannot be negative')
  // A crore of rupees for one line, which no single charge reaches.
  .max(100_000_000_000);

/** Paise as a person reads them: 125000 → "₹1,250.00". */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);
  const rupees = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, '0');

  return `${sign}₹${rupees.toLocaleString('en-IN')}.${remainder}`;
}

/** What a person typed as rupees, as paise. "1,250.50" → 125050. */
export function paiseFromRupees(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;

  const [rupees, paise = ''] = cleaned.split('.');
  return Number(rupees) * 100 + Number(paise.padEnd(2, '0'));
}

export const CATALOGUE_CATEGORY_LABELS: Record<CatalogueCategory, string> = {
  consultation: 'Consultation',
  laboratory: 'Laboratory',
  imaging: 'Imaging',
  procedure: 'Procedure',
  bed: 'Bed',
  pharmacy: 'Pharmacy',
  consumable: 'Consumable',
  other: 'Other',
};

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const catalogueItemInputSchema = z.object({
  /** The hospital's own code for it, as its price list is written. */
  code: z.string().trim().min(1, 'Give it a code').max(40),
  name: z.string().trim().min(2, 'Name it').max(200),
  category: z.enum(CATALOGUE_CATEGORIES),
  /** What one of it is: a visit, a test, a day, a dressing. */
  unit: z.string().trim().min(1).max(40).default('each'),
  pricePaise: paiseSchema,
  /** When this price starts. Today unless the hospital is setting it ahead. */
  activeFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date as YYYY-MM-DD')
    .optional(),
});
export type CatalogueItemInput = z.infer<typeof catalogueItemInputSchema>;

/**
 * A new price for something already in the catalogue.
 *
 * The old row is closed rather than overwritten, so an invoice raised last
 * month can still be read against the price that was in force then.
 */
export const repriceItemSchema = z.object({
  pricePaise: paiseSchema,
  activeFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date as YYYY-MM-DD')
    .optional(),
});
export type RepriceItemInput = z.infer<typeof repriceItemSchema>;

export const retireItemSchema = z.object({
  /** After this date the item is not chargeable. Today unless said otherwise. */
  activeTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date as YYYY-MM-DD')
    .optional(),
});
export type RetireItemInput = z.infer<typeof retireItemSchema>;

export const catalogueItemSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  category: z.enum(CATALOGUE_CATEGORIES),
  unit: z.string(),
  pricePaise: z.number().int(),
  activeFrom: z.string(),
  activeTo: z.string().nullable(),
  /** True for the row in force today: the one a charge is captured against. */
  inForce: z.boolean(),
});
export type CatalogueItem = z.infer<typeof catalogueItemSchema>;

export const catalogueQuerySchema = z.object({
  category: z.enum(CATALOGUE_CATEGORIES).optional(),
  q: z.string().trim().max(100).optional(),
  /** Past prices and retired items as well, for reading an old invoice. */
  history: z.coerce.boolean().default(false),
});
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;

export const catalogueSchema = z.object({ items: z.array(catalogueItemSchema) });
export type Catalogue = z.infer<typeof catalogueSchema>;

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

export const captureChargeSchema = z.object({
  encounterId: uuidSchema,
  itemId: uuidSchema,
  quantity: z.number().int().min(1).max(1000).default(1),
  source: z.enum(CHARGE_SOURCES).default('manual'),
  /** The order, procedure or bed stay it is for, when it is for one. */
  sourceId: uuidSchema.optional(),
  note: z.string().trim().max(500).optional(),
});
export type CaptureChargeInput = z.infer<typeof captureChargeSchema>;

export const voidChargeSchema = z.object({ reason: clinicalReasonSchema });
export type VoidChargeInput = z.infer<typeof voidChargeSchema>;

export const chargeSchema = z.object({
  id: uuidSchema,
  encounterId: uuidSchema,
  patientId: uuidSchema,
  itemId: uuidSchema,
  code: z.string(),
  name: z.string(),
  category: z.enum(CATALOGUE_CATEGORIES),
  unit: z.string(),
  quantity: z.number().int(),
  /** Copied when the charge was captured, so a later price change cannot rewrite it. */
  unitPricePaise: z.number().int(),
  amountPaise: z.number().int(),
  source: z.enum(CHARGE_SOURCES),
  sourceId: uuidSchema.nullable(),
  note: z.string().nullable(),
  status: z.enum(CHARGE_STATUSES),
  capturedAt: z.string(),
  capturedBy: staffRefSchema,
  voidedReason: z.string().nullable(),
  invoiceId: uuidSchema.nullable(),
});
export type Charge = z.infer<typeof chargeSchema>;

/**
 * What the record says is chargeable and has not been charged yet: a resulted
 * order, a procedure that was performed, the days a bed was occupied. The desk
 * decides what each one costs by choosing a catalogue item; nothing is charged
 * automatically, because only the hospital knows what it charges for.
 */
export const unchargedItemSchema = z.object({
  source: z.enum(CHARGE_SOURCES),
  sourceId: uuidSchema,
  description: z.string(),
  /** Bed-days for a stay; one for everything else. */
  quantity: z.number().int(),
  at: z.string(),
  /** The catalogue category it most likely falls under, as a starting point. */
  suggestedCategory: z.enum(CATALOGUE_CATEGORIES),
});
export type UnchargedItem = z.infer<typeof unchargedItemSchema>;

export const encounterChargesSchema = z.object({
  charges: z.array(chargeSchema),
  /** Everything captured and not voided, added up. */
  totalPaise: z.number().int(),
  /** What is on an invoice already, of that total. */
  invoicedPaise: z.number().int(),
  uncharged: z.array(unchargedItemSchema),
});
export type EncounterCharges = z.infer<typeof encounterChargesSchema>;
