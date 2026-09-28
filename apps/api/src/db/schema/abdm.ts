import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { hospitals } from './hospitals';
import { patients } from './patients';
import { staffUsers } from './staff';
import { encounters } from './clinical';
import {
  abdmCareContextStatusEnum,
  abdmLinkInitiatorEnum,
  abdmLinkRequestStatusEnum,
} from './enums';

const primaryId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`)
    .$defaultFn(uuidv7);

/**
 * A visit, exposed to the national network (sp8-plan.md, T10).
 *
 * ABDM calls this a care context: the unit a patient sees in their health app
 * and chooses to share. **Here it is one encounter**, because that is the
 * thing a patient recognises — "the visit on the twelfth of April" — and the
 * thing they can sensibly decide about one at a time. A per-hospital or
 * per-year grouping would be easier to produce and impossible to consent to
 * meaningfully.
 *
 * Two properties are deliberate and easy to get wrong:
 *
 * 1. **The reference is the encounter's own id**, so there is no second
 *    identifier to keep in step with the record it names.
 * 2. **`display` carries no clinical content.** It is shown in the consent
 *    manager's app and travels with every consent request, so a display of
 *    "Diabetes follow-up" would tell anyone looking at that screen — over the
 *    patient's shoulder, or in a list of pending requests — what is wrong
 *    with them. Date, visit type and hospital, and nothing else.
 *
 * A row exists only once a visit has been linked. An encounter with no row
 * here has not been offered to the network at all.
 */
export const abdmCareContexts = pgTable(
  'abdm_care_context',
  {
    id: primaryId(),

    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id, { onDelete: 'restrict' }),

    /** What ABDM knows this visit by. The encounter's id; see above. */
    reference: text('reference').notNull(),
    /** What the patient reads in their app. Never clinical. */
    display: text('display').notNull(),

    initiatedBy: abdmLinkInitiatorEnum('initiated_by').notNull(),
    status: abdmCareContextStatusEnum('status').notNull().default('linked'),

    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null when the patient linked it themselves, from their own app. */
    linkedByStaffId: uuid('linked_by_staff_id').references(() => staffUsers.id),

    unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
    unlinkedReason: text('unlinked_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One visit, one care context. Linking it twice would offer the same
    // record under two references and make unlinking a guess.
    unique('abdm_care_context_encounter_unique').on(table.encounterId),
    index('abdm_care_context_patient_idx').on(table.patientId, table.status),
    index('abdm_care_context_hospital_idx').on(table.hospitalId, table.linkedAt),
  ],
);

export type AbdmCareContext = typeof abdmCareContexts.$inferSelect;

/**
 * A linking attempt, waiting on the patient (sp8-plan.md, T12).
 *
 * Nothing is linked until the patient answers a code, in both directions:
 * when the desk offers the link the gateway sends the code, and when the
 * patient asks from their own app this system sends it. So a request holds
 * what *would* be linked, and the care-context rows are written only on
 * confirmation.
 *
 * The code is stored as a keyed hash and never in clear, and it is **not** a
 * portal sign-in code: keeping the two apart means a code issued to approve a
 * link can never be spent to sign in, which is precisely what sharing SP5's
 * challenge table would have allowed.
 */
export const abdmLinkRequests = pgTable(
  'abdm_link_request',
  {
    id: primaryId(),

    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),

    /** The ABHA the visits would be linked to, as it stood when asked. */
    abhaAddress: text('abha_address').notNull(),

    initiatedBy: abdmLinkInitiatorEnum('initiated_by').notNull(),

    /** The gateway's handle when it holds the challenge; ours when we do. */
    transactionId: text('transaction_id'),

    /** The visits this request would link. Frozen once asked. */
    encounterIds: uuid('encounter_ids').array().notNull(),

    /** Only for a patient-initiated request, where this system sends the code. */
    codeHash: text('code_hash'),
    attempts: integer('attempts').notNull().default(0),

    status: abdmLinkRequestStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    requestedByStaffId: uuid('requested_by_staff_id').references(() => staffUsers.id),

    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('abdm_link_request_patient_idx').on(table.patientId, table.status),
    index('abdm_link_request_expiry_idx').on(table.status, table.expiresAt),
  ],
);

export type AbdmLinkRequest = typeof abdmLinkRequests.$inferSelect;
