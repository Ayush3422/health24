import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import type { Address } from '@health24/shared';
import { facilityTypeEnum, hospitalStatusEnum } from './enums';

/**
 * A hospital is the tenant boundary. Every row of clinical and registry data
 * is owned by exactly one hospital, and Postgres row-level security scopes
 * queries to it.
 */
export const hospitals = pgTable('hospital', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),

  name: text('name').notNull(),
  facilityType: facilityTypeEnum('facility_type').notNull(),

  /** ABDM Health Facility Registry ID, where the facility is registered. */
  hfrId: text('hfr_id').unique(),

  contactEmail: text('contact_email').notNull(),
  contactPhone: text('contact_phone').notNull(),
  address: jsonb('address').$type<Address>(),

  /**
   * Prefix for this hospital's medical record numbers, e.g. `AH` yields
   * `AH-000123`. Hospitals care about this — it prints on every sheet.
   */
  mrnPrefix: text('mrn_prefix').notNull(),

  /**
   * Last issued MRN number for this hospital. Incremented under a row lock so
   * two concurrent registrations cannot receive the same MRN.
   */
  mrnSequence: integer('mrn_sequence').notNull().default(0),

  status: hospitalStatusEnum('status').notNull().default('onboarding'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Hospital = typeof hospitals.$inferSelect;
export type NewHospital = typeof hospitals.$inferInsert;
