import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { accessActionEnum, accessOutcomeEnum, actorTypeEnum } from './enums';

/**
 * The audit trail.
 *
 * Two properties make this table what it is:
 *
 * 1. It records **reads**, not only writes. For PHI that is the requirement,
 *    and it is what lets a patient ask who has looked at their file — which
 *    under the DPDP Act they may.
 *
 * 2. It is append-only. The migration revokes UPDATE and DELETE from the
 *    application role, so an attacker who reaches the API cannot erase their
 *    own tracks. Enforced by the database, not by our discipline.
 *
 * No foreign keys: an audit row must survive the deletion of anything it
 * refers to, and must never be the reason a write fails.
 */
export const accessLog = pgTable(
  'access_log',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    actorId: uuid('actor_id'),
    actorType: actorTypeEnum('actor_type').notNull(),
    /** Denormalised so an audit row is readable without joining a mutable table. */
    actorLabel: text('actor_label'),

    hospitalId: uuid('hospital_id'),

    /** The patient whose data was touched, when there is one. */
    patientId: uuid('patient_id'),

    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),

    action: accessActionEnum('action').notNull(),
    outcome: accessOutcomeEnum('outcome').notNull().default('allowed'),

    /** Populated from SP5 onward, when access rests on a consent artefact. */
    consentArtefactId: uuid('consent_artefact_id'),
    /** Typed justification for emergency access without consent. SP5. */
    breakGlassReason: text('break_glass_reason'),

    /** Correlates every row written while serving one HTTP request. */
    requestId: text('request_id'),
    route: text('route'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('access_log_patient_idx').on(table.patientId, table.at),
    index('access_log_actor_idx').on(table.actorId, table.at),
    index('access_log_hospital_idx').on(table.hospitalId, table.at),
  ],
);

export type AccessLogEntry = typeof accessLog.$inferSelect;
export type NewAccessLogEntry = typeof accessLog.$inferInsert;
