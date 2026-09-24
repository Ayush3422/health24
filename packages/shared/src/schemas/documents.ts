import { z } from 'zod';
import {
  DOCUMENT_AVAILABILITY,
  DOCUMENT_MIME_TYPES,
  DOCUMENT_TYPES,
  FILE_SCAN_STATUSES,
  MAX_DOCUMENT_FILE_BYTES,
  VERSION_STATUSES,
} from '../enums.js';
import { paginationSchema, uuidSchema } from '../primitives.js';
import {
  clinicalDateSchema,
  clinicalReasonSchema,
  hospitalRefSchema,
  staffRefSchema,
} from './clinical.js';

/**
 * Documents (SP4): reports, scans and the rest of a paper file.
 *
 * Files never pass through the API. Creating a document returns one
 * presigned upload per file; the browser uploads straight to storage, then
 * confirms. A document is served only once every file has scanned clean.
 */

/** A phone capture of a long report can run to many pages; beyond this, split it. */
export const MAX_FILES_PER_DOCUMENT = 20;

export const documentDetails = {
  docType: z.enum(DOCUMENT_TYPES),
  title: z.string().trim().min(1).max(200).optional(),
  /** The date printed on the report. */
  reportDate: clinicalDateSchema,
  performingFacility: z.string().trim().min(1).max(200).optional(),
  /** An account of this hospital… */
  orderingClinicianId: uuidSchema.optional(),
  /** …or, for a doctor without one, a name. Never both. */
  orderingClinicianName: z.string().trim().min(2).max(120).optional(),
};

export const oneOrderingClinician = (value: {
  orderingClinicianId?: string;
  orderingClinicianName?: string;
}) => !(value.orderingClinicianId && value.orderingClinicianName);

export const oneOrderingClinicianMessage = {
  message: 'Name the ordering clinician by account or by name, not both',
  path: ['orderingClinicianName'],
};

export const createDocumentSchema = z
  .object({
    patientId: uuidSchema,
    encounterId: uuidSchema.optional(),
    /** The order this report answers, when it was ordered here (SP6, DF2). */
    serviceRequestId: uuidSchema.optional(),
    ...documentDetails,
    /** In order. Only type and size: a file's name is never stored, as it often carries a patient's. */
    files: z
      .array(
        z.object({
          mimeType: z.enum(DOCUMENT_MIME_TYPES),
          sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_FILE_BYTES),
        }),
      )
      .min(1, 'Add at least one file')
      .max(MAX_FILES_PER_DOCUMENT, `A document has at most ${MAX_FILES_PER_DOCUMENT} files`),
  })
  .refine(oneOrderingClinician, oneOrderingClinicianMessage);
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const correctDocumentSchema = z
  .object({ ...documentDetails, reason: clinicalReasonSchema })
  .refine(oneOrderingClinician, oneOrderingClinicianMessage);
export type CorrectDocumentInput = z.infer<typeof correctDocumentSchema>;

export const markDocumentInErrorSchema = z.object({ reason: clinicalReasonSchema });
export type MarkDocumentInErrorInput = z.infer<typeof markDocumentInErrorSchema>;

export const listDocumentsQuerySchema = paginationSchema.extend({
  /** Comma-separated document types. Left out, every type. */
  types: z.preprocess(
    (value) => (typeof value === 'string' && value ? value.split(',') : undefined),
    z.array(z.enum(DOCUMENT_TYPES)).optional(),
  ),
  /** Report dates, inclusive. */
  from: clinicalDateSchema.optional(),
  to: clinicalDateSchema.optional(),
  /** `own`: only this hospital's documents. */
  scope: z.enum(['all', 'own']).default('all'),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

export const documentFileUrlQuerySchema = z.object({
  disposition: z.enum(['inline', 'attachment']).default('inline'),
});
export type DocumentFileUrlQuery = z.infer<typeof documentFileUrlQuerySchema>;

export const documentFileSummarySchema = z.object({
  id: uuidSchema,
  position: z.number().int(),
  mimeType: z.enum(DOCUMENT_MIME_TYPES),
  sizeBytes: z.number().int(),
  scanStatus: z.enum(FILE_SCAN_STATUSES),
  pageCount: z.number().int().nullable(),
});
export type DocumentFileSummary = z.infer<typeof documentFileSummarySchema>;

export const documentSummarySchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  hospital: hospitalRefSchema,
  encounterId: uuidSchema.nullable(),
  importBatchId: uuidSchema.nullable(),
  docType: z.enum(DOCUMENT_TYPES),
  title: z.string().nullable(),
  reportDate: z.string(),
  performingFacility: z.string().nullable(),
  /** `external` for a doctor named without an account. */
  orderingClinician: z
    .object({ id: uuidSchema.nullable(), name: z.string().nullable(), external: z.boolean() })
    .nullable(),
  availability: z.enum(DOCUMENT_AVAILABILITY),
  files: z.array(documentFileSummarySchema),
  recordedBy: staffRefSchema,
  recordedAt: z.string(),
  versionStatus: z.enum(VERSION_STATUSES),
  supersedesId: uuidSchema.nullable(),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const documentListSchema = z.object({
  results: z.array(documentSummarySchema),
  total: z.number().int(),
  /** Whether another hospital's documents are shared with the caller's under consent. */
  sharedFromOtherHospitals: z.boolean(),
});
export type DocumentList = z.infer<typeof documentListSchema>;

export const documentUploadSchema = z.object({
  fileId: uuidSchema,
  position: z.number().int(),
  url: z.string(),
  method: z.literal('PUT'),
  /** Headers to send with the file. Its exact size is also part of the signature. */
  headers: z.record(z.string()),
  expiresAt: z.string(),
});
export type DocumentUpload = z.infer<typeof documentUploadSchema>;

export const createdDocumentSchema = z.object({
  document: documentSummarySchema,
  uploads: z.array(documentUploadSchema),
});
export type CreatedDocument = z.infer<typeof createdDocumentSchema>;

export const documentFileUrlSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
  disposition: z.enum(['inline', 'attachment']),
});
export type DocumentFileUrl = z.infer<typeof documentFileUrlSchema>;
