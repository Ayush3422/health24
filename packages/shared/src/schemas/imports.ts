import { z } from 'zod';
import {
  DOCUMENT_MIME_TYPES,
  DOCUMENT_TYPES,
  FILE_SCAN_STATUSES,
  IMPORT_BATCH_STATUSES,
  MAX_DOCUMENT_FILE_BYTES,
  VERSION_STATUSES,
} from '../enums.js';
import { uuidSchema } from '../primitives.js';
import { clinicalReasonSchema, staffRefSchema } from './clinical.js';
import {
  documentDetails,
  documentUploadSchema,
  oneOrderingClinician,
  oneOrderingClinicianMessage,
} from './documents.js';

/**
 * Legacy paper files (SP4 Phase 6, Decision E1).
 *
 * Records staff open an import batch for a patient and upload the scanned
 * folder. Each file is kept as the original and scanned; once clean, the
 * worker cuts it into pages. Staff then make documents from pages, or
 * exclude a page with a reason, until every page is accounted for.
 */

/** One upload of a folder's files; a larger folder is uploaded in several goes. */
export const MAX_IMPORT_FILES_PER_UPLOAD = 200;

/** A long discharge summary runs to many pages, but a document is still one report. */
export const MAX_PAGES_PER_IMPORTED_DOCUMENT = 100;

export const IMPORT_PAGE_STATES = ['unassigned', 'classified', 'excluded'] as const;
export type ImportPageState = (typeof IMPORT_PAGE_STATES)[number];

export const openImportBatchSchema = z.object({
  patientId: uuidSchema,
  /** e.g. "OPD folder, 2014–2019". Never a file name. */
  note: z.string().trim().min(1).max(500).optional(),
});
export type OpenImportBatchInput = z.infer<typeof openImportBatchSchema>;

export const addImportFilesSchema = z.object({
  /** In the folder's order. Only type and size: a file's name is never stored. */
  files: z
    .array(
      z.object({
        mimeType: z.enum(DOCUMENT_MIME_TYPES),
        sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_FILE_BYTES),
      }),
    )
    .min(1, 'Add at least one file')
    .max(
      MAX_IMPORT_FILES_PER_UPLOAD,
      `Upload at most ${MAX_IMPORT_FILES_PER_UPLOAD} files at a time`,
    ),
});
export type AddImportFilesInput = z.infer<typeof addImportFilesSchema>;

const distinctPages = (value: { pageIds: string[] }) =>
  new Set(value.pageIds.map((id) => id.toLowerCase())).size === value.pageIds.length;

const distinctPagesMessage = { message: 'A page is selected twice', path: ['pageIds'] };

/** Makes one document from pages, in the order given. */
export const classifyImportPagesSchema = z
  .object({
    pageIds: z
      .array(uuidSchema)
      .min(1, 'Select at least one page')
      .max(
        MAX_PAGES_PER_IMPORTED_DOCUMENT,
        `A document has at most ${MAX_PAGES_PER_IMPORTED_DOCUMENT} pages`,
      ),
    ...documentDetails,
  })
  .refine(oneOrderingClinician, oneOrderingClinicianMessage)
  .refine(distinctPages, distinctPagesMessage);
export type ClassifyImportPagesInput = z.infer<typeof classifyImportPagesSchema>;

/** Pages that are not part of this patient's record: kept, never deleted, with the reason. */
export const excludeImportPagesSchema = z
  .object({
    pageIds: z.array(uuidSchema).min(1, 'Select at least one page').max(1_000),
    reason: clinicalReasonSchema,
  })
  .refine(distinctPages, distinctPagesMessage);
export type ExcludeImportPagesInput = z.infer<typeof excludeImportPagesSchema>;

export const importFileSummarySchema = z.object({
  id: uuidSchema,
  position: z.number().int(),
  mimeType: z.enum(DOCUMENT_MIME_TYPES),
  sizeBytes: z.number().int(),
  uploadConfirmed: z.boolean(),
  /** Never confirmed within a day, and removed. */
  abandoned: z.boolean(),
  scanStatus: z.enum(FILE_SCAN_STATUSES),
  pageCount: z.number().int().nullable(),
  /** Its pages have been cut and can be classified. */
  pagesReady: z.boolean(),
});
export type ImportFileSummary = z.infer<typeof importFileSummarySchema>;

export const importPageSummarySchema = z.object({
  id: uuidSchema,
  fileId: uuidSchema,
  filePosition: z.number().int(),
  pageNumber: z.number().int(),
  mimeType: z.enum(DOCUMENT_MIME_TYPES),
  state: z.enum(IMPORT_PAGE_STATES),
  documentId: uuidSchema.nullable(),
  excludedReason: z.string().nullable(),
});
export type ImportPageSummary = z.infer<typeof importPageSummarySchema>;

export const importBatchDocumentSchema = z.object({
  id: uuidSchema,
  docType: z.enum(DOCUMENT_TYPES),
  title: z.string().nullable(),
  reportDate: z.string(),
  pageCount: z.number().int(),
  versionStatus: z.enum(VERSION_STATUSES),
});
export type ImportBatchDocument = z.infer<typeof importBatchDocumentSchema>;

export const importProgressSchema = z.object({
  files: z.number().int(),
  /** Uploaded but not yet confirmed, or confirmed and not yet scanned and cut into pages. */
  filesInProgress: z.number().int(),
  filesQuarantined: z.number().int(),
  pages: z.number().int(),
  classified: z.number().int(),
  excluded: z.number().int(),
  unassigned: z.number().int(),
});
export type ImportProgress = z.infer<typeof importProgressSchema>;

const importBatchFields = {
  id: uuidSchema,
  patientId: uuidSchema,
  status: z.enum(IMPORT_BATCH_STATUSES),
  note: z.string().nullable(),
  openedBy: staffRefSchema,
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  progress: importProgressSchema,
};

export const importBatchListItemSchema = z.object(importBatchFields);
export type ImportBatchListItem = z.infer<typeof importBatchListItemSchema>;

export const importBatchListSchema = z.object({ batches: z.array(importBatchListItemSchema) });
export type ImportBatchList = z.infer<typeof importBatchListSchema>;

export const importBatchSummarySchema = z.object({
  ...importBatchFields,
  files: z.array(importFileSummarySchema),
  pages: z.array(importPageSummarySchema),
  documents: z.array(importBatchDocumentSchema),
  /** At least one file, every page classified or excluded, and no file still in progress. */
  canFinish: z.boolean(),
});
export type ImportBatchSummary = z.infer<typeof importBatchSummarySchema>;

export const importFilesAddedSchema = z.object({
  batch: importBatchSummarySchema,
  uploads: z.array(documentUploadSchema),
});
export type ImportFilesAdded = z.infer<typeof importFilesAddedSchema>;

/** Doctors this hospital has already named without an account, to be named the same way again. */
export const externalClinicianQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
});
export type ExternalClinicianQuery = z.infer<typeof externalClinicianQuerySchema>;

export const externalClinicianNamesSchema = z.object({ names: z.array(z.string()) });
export type ExternalClinicianNames = z.infer<typeof externalClinicianNamesSchema>;
