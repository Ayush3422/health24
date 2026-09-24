import { sql } from 'drizzle-orm';
import {
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import { encounters } from './clinical';
import {
  documentAvailabilityEnum,
  documentTypeEnum,
  fileScanStatusEnum,
  importBatchStatusEnum,
  versionStatusEnum,
} from './enums';
import { hospitals } from './hospitals';
import { patients } from './patients';
import { staffUsers } from './staff';

/**
 * Documents and their files (SP4).
 *
 * The same rules as the clinical record, from SP3:
 *
 *   1. Tenant-scoped under row-level security. Another hospital sees a
 *      document only under consent for `documents` on its report date
 *      (sp4-plan.md, Decision G1); its files are visible exactly when it is.
 *   2. Never edited or deleted. Details are corrected as a new version; a
 *      wrong upload is marked entered in error.
 *   3. Composite foreign keys carry the patient and hospital through every
 *      reference, so a file cannot belong to another patient's document.
 *
 * A document is attributed to whoever uploaded it — the front desk, records
 * staff or a clinician. The ordering clinician is a reference, by account or
 * by name (sp4-plan.md, DF7).
 */

const primaryId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`)
    .$defaultFn(uuidv7);

/** A legacy paper folder, uploaded whole and classified into documents (Decision E1). */
export const importBatches = pgTable(
  'import_batch',
  {
    id: primaryId(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    openedByStaffId: uuid('opened_by_staff_id').notNull(),
    status: importBatchStatusEnum('status').notNull().default('open'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    unique('import_batch_identity').on(table.id, table.patientId, table.hospitalId),
    foreignKey({
      name: 'import_batch_opened_by_same_hospital_fk',
      columns: [table.openedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('import_batch_hospital_idx').on(table.hospitalId, table.status),
  ],
);

export type ImportBatch = typeof importBatches.$inferSelect;

export const documentReferences = pgTable(
  'document_reference',
  {
    id: primaryId(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    /** The visit it belongs to, when there is one. A report brought from outside often has none. */
    encounterId: uuid('encounter_id'),
    /** The legacy folder it was classified from. */
    importBatchId: uuid('import_batch_id'),
    /** The order this report answers, when it was ordered here (SP6, DF2). */
    serviceRequestId: uuid('service_request_id'),

    docType: documentTypeEnum('doc_type').notNull(),
    title: text('title'),
    /** The date on the report — what consent date ranges and the timeline use. */
    reportDate: date('report_date').notNull(),
    performingFacility: text('performing_facility'),
    /** An account of this hospital, or — for a doctor without one — a name. Never both. */
    orderingClinicianId: uuid('ordering_clinician_id'),
    orderingClinicianName: text('ordering_clinician_name'),

    /** Served only once `available`: every file scanned clean. */
    availability: documentAvailabilityEnum('availability').notNull().default('pending_scan'),
    availabilityChangedAt: timestamp('availability_changed_at', { withTimezone: true }),
    /** When the uploader confirmed every file reached storage. Until then, an upload can be abandoned. */
    uploadConfirmedAt: timestamp('upload_confirmed_at', { withTimezone: true }),

    /** Who uploaded it. */
    recordedByStaffId: uuid('recorded_by_staff_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),

    versionStatus: versionStatusEnum('version_status').notNull().default('current'),
    supersedesId: uuid('supersedes_id'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    statusChangedByStaffId: uuid('status_changed_by_staff_id'),
    statusReason: text('status_reason'),
  },
  (table) => [
    unique('document_reference_identity').on(table.id, table.patientId, table.hospitalId),
    unique('document_reference_supersedes_once').on(table.supersedesId),
    // Lets an import page name a document of its own batch.
    unique('document_reference_batch_identity').on(
      table.id,
      table.importBatchId,
      table.patientId,
      table.hospitalId,
    ),
    foreignKey({
      name: 'document_reference_encounter_same_record_fk',
      columns: [table.encounterId, table.patientId, table.hospitalId],
      foreignColumns: [encounters.id, encounters.patientId, encounters.hospitalId],
    }),
    foreignKey({
      name: 'document_reference_import_batch_same_record_fk',
      columns: [table.importBatchId, table.patientId, table.hospitalId],
      foreignColumns: [importBatches.id, importBatches.patientId, importBatches.hospitalId],
    }),
    foreignKey({
      name: 'document_reference_supersedes_same_record_fk',
      columns: [table.supersedesId, table.patientId, table.hospitalId],
      foreignColumns: [table.id, table.patientId, table.hospitalId],
    }),
    foreignKey({
      name: 'document_reference_recorded_by_same_hospital_fk',
      columns: [table.recordedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'document_reference_ordering_clinician_same_hospital_fk',
      columns: [table.orderingClinicianId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'document_reference_status_changed_by_fk',
      columns: [table.statusChangedByStaffId],
      foreignColumns: [staffUsers.id],
    }),
    index('document_reference_patient_idx').on(table.patientId, table.reportDate),
    index('document_reference_hospital_idx').on(table.hospitalId, table.recordedAt),
    index('document_reference_import_batch_idx').on(table.importBatchId),
  ],
);

export type DocumentReference = typeof documentReferences.$inferSelect;

/**
 * One file of a document, in order: a three-page report photographed on a
 * phone is one document with three files. A corrected version of a document
 * carries rows for the same stored objects.
 */
export const documentFiles = pgTable(
  'document_file',
  {
    id: primaryId(),
    documentId: uuid('document_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    hospitalId: uuid('hospital_id').notNull(),

    position: integer('position').notNull(),
    /** Built from identifiers alone; the database checks it names this hospital and patient. */
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Set once the upload is confirmed. */
    sha256: text('sha256'),

    scanStatus: fileScanStatusEnum('scan_status').notNull().default('pending'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    scanSignature: text('scan_signature'),
    pageCount: integer('page_count'),
    thumbnailKey: text('thumbnail_key'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('document_file_position_once').on(table.documentId, table.position),
    foreignKey({
      name: 'document_file_document_same_record_fk',
      columns: [table.documentId, table.patientId, table.hospitalId],
      foreignColumns: [
        documentReferences.id,
        documentReferences.patientId,
        documentReferences.hospitalId,
      ],
    }).onDelete('restrict'),
    index('document_file_document_idx').on(table.documentId),
  ],
);

export type DocumentFile = typeof documentFiles.$inferSelect;

/**
 * A legacy folder's file as uploaded (Decision E1): kept as the original and
 * scanned like any upload, but never served to a clinician. Once clean, the
 * worker cuts it into pages.
 */
export const importFiles = pgTable(
  'import_file',
  {
    id: primaryId(),
    batchId: uuid('batch_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    hospitalId: uuid('hospital_id').notNull(),

    /** Its order in the folder, across every upload to the batch. */
    position: integer('position').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256'),

    uploadConfirmedAt: timestamp('upload_confirmed_at', { withTimezone: true }),
    /** Never confirmed within a day; its object was removed. */
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),

    scanStatus: fileScanStatusEnum('scan_status').notNull().default('pending'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    scanSignature: text('scan_signature'),
    pageCount: integer('page_count'),
    /** When its pages were cut. */
    pagesCreatedAt: timestamp('pages_created_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('import_file_position_once').on(table.batchId, table.position),
    unique('import_file_storage_key_once').on(table.storageKey),
    unique('import_file_identity').on(table.id, table.batchId, table.patientId, table.hospitalId),
    foreignKey({
      name: 'import_file_batch_same_record_fk',
      columns: [table.batchId, table.patientId, table.hospitalId],
      foreignColumns: [importBatches.id, importBatches.patientId, importBatches.hospitalId],
    }).onDelete('restrict'),
    index('import_file_batch_idx').on(table.batchId),
  ],
);

export type ImportFile = typeof importFiles.$inferSelect;

/**
 * One page of an import file: the unit staff classify. It becomes part of
 * exactly one document, or is excluded with a reason — once, and never both.
 */
export const importPages = pgTable(
  'import_page',
  {
    id: primaryId(),
    batchId: uuid('batch_id').notNull(),
    fileId: uuid('file_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    hospitalId: uuid('hospital_id').notNull(),

    /** From 1, within its file. */
    pageNumber: integer('page_number').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),

    documentId: uuid('document_id'),
    classifiedAt: timestamp('classified_at', { withTimezone: true }),
    classifiedByStaffId: uuid('classified_by_staff_id'),

    excludedAt: timestamp('excluded_at', { withTimezone: true }),
    excludedByStaffId: uuid('excluded_by_staff_id'),
    excludedReason: text('excluded_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('import_page_number_once').on(table.fileId, table.pageNumber),
    unique('import_page_storage_key_once').on(table.storageKey),
    foreignKey({
      name: 'import_page_file_same_record_fk',
      columns: [table.fileId, table.batchId, table.patientId, table.hospitalId],
      foreignColumns: [
        importFiles.id,
        importFiles.batchId,
        importFiles.patientId,
        importFiles.hospitalId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'import_page_document_same_batch_fk',
      columns: [table.documentId, table.batchId, table.patientId, table.hospitalId],
      foreignColumns: [
        documentReferences.id,
        documentReferences.importBatchId,
        documentReferences.patientId,
        documentReferences.hospitalId,
      ],
    }),
    foreignKey({
      name: 'import_page_classified_by_same_hospital_fk',
      columns: [table.classifiedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    foreignKey({
      name: 'import_page_excluded_by_same_hospital_fk',
      columns: [table.excludedByStaffId, table.hospitalId],
      foreignColumns: [staffUsers.id, staffUsers.hospitalId],
    }),
    index('import_page_batch_idx').on(table.batchId),
    index('import_page_document_idx').on(table.documentId),
  ],
);

export type ImportPage = typeof importPages.$inferSelect;
