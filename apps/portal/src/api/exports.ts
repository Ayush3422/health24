import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DataExportSummary, ExportDownload, ExportFormat } from '@health24/shared';
import { api } from './client';

const EXPORTS = ['portal', 'exports'] as const;

export function useExports() {
  return useQuery({
    queryKey: EXPORTS,
    queryFn: () => api<DataExportSummary[]>('/portal/exports'),
    // A pending export becomes ready in the background.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((item) => item.status === 'pending') ? 5_000 : false,
  });
}

export function useRequestExport() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api<DataExportSummary>('/portal/exports', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXPORTS }),
  });
}

/** A link to one file of a ready export; it lasts an hour. */
export function exportDownload(exportId: string, format: ExportFormat): Promise<ExportDownload> {
  return api<ExportDownload>(`/portal/exports/${exportId}/download?format=${format}`);
}
