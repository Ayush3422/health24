import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OfflineViewsResult } from '@health24/shared';
import { api } from '../api/client';
import { clearQueuedViews, forgetResponses, queuedViews } from './cache';
import { onReconnect } from './connectivity';

const UPLOAD_BATCH = 500;

/**
 * What happens when the connection returns, in this order:
 *
 * 1. Views made offline are uploaded to the audit trail. If the upload fails
 *    they stay queued for the next reconnection; a session that never
 *    reconnects loses them — the stated, accepted gap.
 * 2. Every cached response is dropped, so nothing outlives a consent revoked
 *    while offline.
 * 3. The screens refetch, which refills the cache with what is permitted now.
 */
export function useOfflineSync(): void {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      onReconnect(() => {
        void (async () => {
          const views = await queuedViews();

          try {
            for (let start = 0; start < views.length; start += UPLOAD_BATCH) {
              await api<OfflineViewsResult>('/audit/offline-views', {
                method: 'POST',
                body: { views: views.slice(start, start + UPLOAD_BATCH) },
              });
            }

            if (views.length > 0) await clearQueuedViews();
          } catch {
            // Kept for the next reconnection.
          }

          await forgetResponses();
          await queryClient.invalidateQueries();
        })();
      }),
    [queryClient],
  );
}
