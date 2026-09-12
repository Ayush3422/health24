import {
  boolean,
  date,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { staffUsers } from './staff';
import {
  codeSystemStatusEnum,
  designationUseEnum,
  mapElementStatusEnum,
  mapEquivalenceEnum,
  mapProvenanceEnum,
  mapReviewActionEnum,
  mapReviewPolicyEnum,
} from './enums';

/**
 * Terminology is reference data, not patient data, so none of these tables is
 * tenant-scoped. Every hospital reads the same vocabulary.
 *
 * Releases are immutable. A code system version, once imported, never changes:
 * concepts and designations are not updated or deleted (enforced by grant in
 * the migration), and a re-import of the same version with different content
 * is refused by comparing content hashes. A new publisher release is a new row
 * with a new version, and records coded against the old one keep resolving.
 */

/** One version of one code system: `namaste` 2025-01, `icd11-tm2` 2025-02. */
export const codeSystems = pgTable(
  'code_system',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    /** Stable internal key, the same across versions: `namaste`. */
    key: text('key').notNull(),
    /** The publisher's canonical identifier, as issued. */
    uri: text('uri').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    publisher: text('publisher').notNull(),

    status: codeSystemStatusEnum('status').notNull().default('draft'),

    /** Never to be used on a real patient record. Every demo release sets this. */
    experimental: boolean('experimental').notNull().default(false),

    licence: text('licence'),
    /** Citation the licence requires to be displayed alongside the codes. */
    attribution: text('attribution'),

    releasedAt: date('released_at'),

    /** SHA-256 of the canonicalised release, for idempotent re-import. */
    contentHash: text('content_hash').notNull(),

    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    /** Who ran the import. Imports come from the CLI, not a signed-in session. */
    importedBy: text('imported_by').notNull(),

    activatedAt: timestamp('activated_at', { withTimezone: true }),
    activatedByStaffId: uuid('activated_by_staff_id').references(() => staffUsers.id),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    unique('code_system_key_version_unique').on(table.key, table.version),
    index('code_system_key_idx').on(table.key),
  ],
);

export type CodeSystem = typeof codeSystems.$inferSelect;

export const concepts = pgTable(
  'concept',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    codeSystemId: uuid('code_system_id')
      .notNull()
      .references(() => codeSystems.id, { onDelete: 'restrict' }),

    /** Exactly as published. Never normalised — see `conceptCodeSchema`. */
    code: text('code').notNull(),
    display: text('display').notNull(),
    definition: text('definition'),
    parentCode: text('parent_code'),
  },
  (table) => [
    unique('concept_system_code_unique').on(table.codeSystemId, table.code),
    index('concept_parent_idx').on(table.codeSystemId, table.parentCode),
  ],
);

export type Concept = typeof concepts.$inferSelect;

/**
 * Every name a concept is known by: its display, synonyms, and the same term
 * in other scripts. Search runs over this table rather than over displays
 * alone, which is what lets अम्लपित्त and Amlapitta reach the same concept.
 */
export const conceptDesignations = pgTable(
  'concept_designation',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    conceptId: uuid('concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'restrict' }),

    language: text('language').notNull(),
    use: designationUseEnum('use').notNull(),
    value: text('value').notNull(),

    /**
     * `foldTerm(value)`. Computed in the application with the same function
     * the search box uses, so index and query can never fold differently.
     */
    valueFolded: text('value_folded').notNull(),
  },
  (table) => [index('concept_designation_concept_idx').on(table.conceptId)],
);

/** A versioned map between two code system versions: NAMASTE → ICD-11 TM2. */
export const conceptMaps = pgTable(
  'concept_map',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    key: text('key').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    publisher: text('publisher').notNull(),

    sourceSystemId: uuid('source_system_id')
      .notNull()
      .references(() => codeSystems.id, { onDelete: 'restrict' }),
    targetSystemId: uuid('target_system_id')
      .notNull()
      .references(() => codeSystems.id, { onDelete: 'restrict' }),

    experimental: boolean('experimental').notNull().default(false),
    reviewPolicy: mapReviewPolicyEnum('review_policy').notNull(),
    licence: text('licence'),
    attribution: text('attribution'),

    contentHash: text('content_hash').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    importedBy: text('imported_by').notNull(),
  },
  (table) => [unique('concept_map_key_version_unique').on(table.key, table.version)],
);

export type ConceptMap = typeof conceptMaps.$inferSelect;

/**
 * One mapping. Its `status` is the whole safety story: only `approved`
 * elements are ever attached to a patient's diagnosis, so an imported but
 * unreviewed correspondence cannot reach a record until a curator has looked.
 */
export const conceptMapElements = pgTable(
  'concept_map_element',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    conceptMapId: uuid('concept_map_id')
      .notNull()
      .references(() => conceptMaps.id, { onDelete: 'restrict' }),

    sourceCode: text('source_code').notNull(),
    /** Null exactly when the equivalence is `unmatched`. */
    targetCode: text('target_code'),

    equivalence: mapEquivalenceEnum('equivalence').notNull(),
    confidence: doublePrecision('confidence'),
    comment: text('comment'),

    status: mapElementStatusEnum('status').notNull().default('proposed'),
    provenance: mapProvenanceEnum('provenance').notNull(),

    /** Null for imported elements. */
    proposedByStaffId: uuid('proposed_by_staff_id').references(() => staffUsers.id),
    reviewedByStaffId: uuid('reviewed_by_staff_id').references(() => staffUsers.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewComment: text('review_comment'),

    /** The approved element this one corrects, when it is a correction. */
    supersedesElementId: uuid('supersedes_element_id').references(
      (): AnyPgColumn => conceptMapElements.id,
    ),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('concept_map_element_lookup_idx').on(table.conceptMapId, table.sourceCode, table.status),
    index('concept_map_element_status_idx').on(table.status),
  ],
);

export type ConceptMapElement = typeof conceptMapElements.$inferSelect;

/**
 * Every decision ever made about a mapping, append-only.
 *
 * The element row carries only its current state. This carries the history:
 * who imported it, who proposed a change, who approved it, who later retired
 * it and why. Clinical governance is answerable only if that trail exists.
 */
export const conceptMapReviews = pgTable(
  'concept_map_review',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),

    elementId: uuid('element_id')
      .notNull()
      .references(() => conceptMapElements.id, { onDelete: 'restrict' }),

    action: mapReviewActionEnum('action').notNull(),

    /** Null for imports, which are run from the CLI. */
    staffId: uuid('staff_id').references(() => staffUsers.id),
    /** Denormalised, so the history reads correctly after an account changes. */
    actorLabel: text('actor_label').notNull(),

    comment: text('comment'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('concept_map_review_element_idx').on(table.elementId)],
);
