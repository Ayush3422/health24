import { useMutation, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  correctDocumentSchema,
  CreatedDocument,
  createDocumentSchema,
  DocumentFileUrl,
  DocumentList,
  DocumentSummary,
  DocumentType,
  DocumentUpload,
  recordResultsSchema,
  ResultSet,
  ResultSetList,
  ResultTrend,
} from '@health24/shared';
import { api } from './client';
import { useInvalidateClinical } from './clinical';

/**
 * Documents and lab results (SP4). Under the clinical cache key, so recording
 * consent or withdrawing an entry refetches them with everything else.
 */

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  lab_report: 'Lab report',
  radiology: 'Radiology',
  discharge_summary: 'Discharge summary',
  prescription: 'Prescription',
  operative_note: 'Operative note',
  referral: 'Referral',
  bill_or_receipt: 'Bill or receipt',
  other: 'Other',
};

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocumentFilters {
  types: DocumentType[];
  from: string;
  to: string;
  scope: 'all' | 'own';
}

export function usePatientDocuments(patientId: string, filters: DocumentFilters) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'documents', filters],
    queryFn: () => {
      const params = new URLSearchParams({ scope: filters.scope, limit: '100' });
      if (filters.types.length > 0) params.set('types', filters.types.join(','));
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);

      return api<DocumentList>(`/patients/${patientId}/documents?${params.toString()}`);
    },
    // Keep asking while a scan is in progress, so a report opens as soon as it is clean.
    refetchInterval: (query) =>
      query.state.data?.results.some((document) => document.availability === 'pending_scan')
        ? 2_000
        : false,
  });
}

export function useCreateDocument() {
  return useMutation({
    mutationFn: (body: z.input<typeof createDocumentSchema>) =>
      api<CreatedDocument>('/documents', { method: 'POST', body }),
  });
}

export const completeDocument = (documentId: string) =>
  api<DocumentSummary>(`/documents/${documentId}/complete`, { method: 'POST' });

/**
 * Sends one file straight to storage. XHR rather than fetch, for upload
 * progress; the signed URL binds the content type and the exact size.
 */
export function putFile(
  upload: DocumentUpload,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(upload.method, upload.url);

    for (const [name, value] of Object.entries(upload.headers)) {
      request.setRequestHeader(name, value);
    }

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`Storage refused the upload (${request.status})`));
    request.onerror = () => reject(new Error('The upload could not reach storage'));

    request.send(file);
  });
}

export function useCorrectDocument() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof correctDocumentSchema> }) =>
      api<DocumentSummary>(`/documents/${id}/correct`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useMarkDocumentInError() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<DocumentSummary>(`/documents/${id}/entered-in-error`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: invalidate,
  });
}

/**
 * A link to one file. Each is issued fresh, audited, and valid for a minute,
 * so it is kept briefly for the open viewer and never beyond it.
 */
export function useDocumentFileLink(documentId: string, fileId: string | undefined) {
  return useQuery({
    queryKey: ['document-file-link', documentId, fileId],
    queryFn: () =>
      api<DocumentFileUrl>(`/documents/${documentId}/files/${fileId}/url?disposition=inline`),
    enabled: Boolean(fileId),
    staleTime: 45_000,
    gcTime: 0,
    retry: false,
  });
}

export const fetchDownloadLink = (documentId: string, fileId: string) =>
  api<DocumentFileUrl>(`/documents/${documentId}/files/${fileId}/url?disposition=attachment`);

// ---------------------------------------------------------------------------
// Lab results
// ---------------------------------------------------------------------------

export function usePatientResults(patientId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'results'],
    queryFn: () => api<ResultSetList>(`/patients/${patientId}/results`),
    enabled,
  });
}

export function useResultTrend(patientId: string, code: string | null) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'results', 'trend', code],
    queryFn: () =>
      api<ResultTrend>(
        `/patients/${patientId}/results/trends?code=${encodeURIComponent(code ?? '')}`,
      ),
    enabled: Boolean(code),
  });
}

export function useRecordResults() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof recordResultsSchema>) =>
      api<ResultSet>('/results', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useMarkResultsInError() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api(`/results/${id}/entered-in-error`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}
