import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  classifyImportPagesSchema,
  DocumentFileUrl,
  DocumentMimeType,
  ExternalClinicianNames,
  ImportBatchList,
  ImportBatchSummary,
  ImportFilesAdded,
  openImportBatchSchema,
} from '@health24/shared';
import { api } from './client';
import { useInvalidateClinical } from './clinical';

/**
 * Legacy paper file imports (SP4 Phase 6). Under the clinical cache key, so a
 * document made from pages refreshes the patient's documents too.
 */

const batchKey = (batchId: string) => ['clinical', 'import', batchId] as const;

export function usePatientImports(patientId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'imports'],
    queryFn: () => api<ImportBatchList>(`/patients/${patientId}/imports`),
    enabled,
  });
}

export function useImportBatch(batchId: string) {
  return useQuery({
    queryKey: batchKey(batchId),
    queryFn: () => api<ImportBatchSummary>(`/imports/${batchId}`),
    // Keep asking while files are checked for viruses and cut into pages.
    refetchInterval: (query) =>
      (query.state.data?.progress.filesInProgress ?? 0) > 0 ? 2_000 : false,
  });
}

export function useOpenImport() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof openImportBatchSchema>) =>
      api<ImportBatchSummary>('/imports', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export const addImportFiles = (
  batchId: string,
  files: Array<{ mimeType: DocumentMimeType; sizeBytes: number }>,
) => api<ImportFilesAdded>(`/imports/${batchId}/files`, { method: 'POST', body: { files } });

export const completeImportFiles = (batchId: string) =>
  api<ImportBatchSummary>(`/imports/${batchId}/files/complete`, { method: 'POST' });

/** A change to the batch: the server's answer is the new batch, shown at once. */
function useBatchMutation<TInput>(
  batchId: string,
  request: (input: TInput) => Promise<ImportBatchSummary>,
) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: request,
    onSuccess: async (summary) => {
      queryClient.setQueryData(batchKey(batchId), summary);
      await invalidate();
    },
  });
}

export const useClassifyPages = (batchId: string) =>
  useBatchMutation(batchId, (body: z.input<typeof classifyImportPagesSchema>) =>
    api<ImportBatchSummary>(`/imports/${batchId}/documents`, { method: 'POST', body }),
  );

export const useExcludePages = (batchId: string) =>
  useBatchMutation(batchId, (body: { pageIds: string[]; reason: string }) =>
    api<ImportBatchSummary>(`/imports/${batchId}/exclusions`, { method: 'POST', body }),
  );

export const useFinishImport = (batchId: string) =>
  useBatchMutation<void>(batchId, () =>
    api<ImportBatchSummary>(`/imports/${batchId}/finish`, { method: 'POST' }),
  );

/** A one-minute, audited link to one page: kept briefly for the open preview only. */
export function useImportPageLink(batchId: string, pageId: string | null) {
  return useQuery({
    queryKey: ['import-page-link', batchId, pageId],
    queryFn: () => api<DocumentFileUrl>(`/imports/${batchId}/pages/${pageId}/url`),
    enabled: Boolean(pageId),
    staleTime: 45_000,
    gcTime: 0,
    retry: false,
  });
}

/** Names this hospital has already given doctors without an account (T20). */
export function useExternalClinicians(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ['external-clinicians', query],
    queryFn: () =>
      api<ExternalClinicianNames>(`/external-clinicians?q=${encodeURIComponent(query)}`),
    enabled,
    staleTime: 60_000,
  });
}
