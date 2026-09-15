import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  ClinicalDataCategory,
  DocumentFileUrl,
  DocumentList,
  ResultSetList,
  ResultTrend,
  TimelinePage,
} from '@health24/shared';
import { api } from './client';

const TIMELINE_PAGE = 50;
const DOCUMENTS_PAGE = 50;

/** The patient's timeline, newest first; `categories` null for everything. */
export function useTimeline(categories: readonly ClinicalDataCategory[] | null) {
  return useInfiniteQuery({
    queryKey: ['portal', 'timeline', categories?.join(',') ?? 'all'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(TIMELINE_PAGE) });
      if (categories) params.set('categories', categories.join(','));
      if (pageParam) params.set('before', pageParam);
      return api<TimelinePage>(`/portal/timeline?${params}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
}

export function useDocuments() {
  return useInfiniteQuery({
    queryKey: ['portal', 'documents'],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api<DocumentList>(`/portal/documents?limit=${DOCUMENTS_PAGE}&page=${pageParam}`),
    getNextPageParam: (last, pages) =>
      pages.length * DOCUMENTS_PAGE < last.total ? pages.length + 1 : undefined,
  });
}

export function useResults() {
  return useQuery({
    queryKey: ['portal', 'results'],
    queryFn: () => api<ResultSetList>('/portal/results'),
  });
}

export function useTrend(code: string) {
  return useQuery({
    queryKey: ['portal', 'trend', code],
    queryFn: () => api<ResultTrend>(`/portal/results/trends?${new URLSearchParams({ code })}`),
    enabled: code.length > 0,
  });
}

/** A short-lived link to one file: `inline` to view, `attachment` to download. */
export function fileUrl(
  documentId: string,
  fileId: string,
  disposition: 'inline' | 'attachment',
): Promise<DocumentFileUrl> {
  return api<DocumentFileUrl>(
    `/portal/documents/${documentId}/files/${fileId}/url?disposition=${disposition}`,
  );
}
