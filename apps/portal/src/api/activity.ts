import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AccessHistoryPage, PortalNotifications } from '@health24/shared';
import { api } from './client';

const HISTORY_PAGE = 50;

/** Who has read the record, newest day first. */
export function useAccessHistory() {
  return useInfiniteQuery({
    queryKey: ['portal', 'access-history'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE) });
      if (pageParam) params.set('before', pageParam);
      return api<AccessHistoryPage>(`/portal/access-history?${params}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
}

/** Emergency access to the record: shown on the home screen and in the history. */
export function useNotifications() {
  return useQuery({
    queryKey: ['portal', 'notifications'],
    queryFn: () => api<PortalNotifications>('/portal/notifications'),
  });
}
