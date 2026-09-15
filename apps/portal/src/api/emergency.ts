import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EmergencyCardField,
  EmergencyPage,
  PortalEmergencyCard,
  PortalEmergencyCardState,
} from '@health24/shared';
import { api } from './client';

const CARD = ['portal', 'emergency-card'] as const;

export function useEmergencyCard() {
  return useQuery({
    queryKey: CARD,
    queryFn: () => api<PortalEmergencyCardState>('/portal/emergency-card'),
  });
}

function useCardMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CARD }),
  });
}

export const useCreateCard = () =>
  useCardMutation((fields: EmergencyCardField[]) =>
    api<PortalEmergencyCard>('/portal/emergency-card', { method: 'POST', body: { fields } }),
  );

export const useUpdateCard = () =>
  useCardMutation((fields: EmergencyCardField[]) =>
    api<PortalEmergencyCard>('/portal/emergency-card', { method: 'PATCH', body: { fields } }),
  );

export const useReplaceCard = () =>
  useCardMutation((_: void) =>
    api<PortalEmergencyCard>('/portal/emergency-card/replace', { method: 'POST' }),
  );

export const useRevokeCard = () =>
  useCardMutation((_: void) => api<void>('/portal/emergency-card/revoke', { method: 'POST' }));

/** The page a card's QR code opens. Never retried: a guess is not worth a second try. */
export function useEmergencyPage(token: string) {
  return useQuery({
    queryKey: ['emergency-page', token],
    queryFn: () => api<EmergencyPage>(`/emergency/${encodeURIComponent(token)}`),
    retry: false,
    staleTime: 0,
  });
}

/** The address a card's QR code carries: this portal's own public page. */
export function cardUrl(token: string): string {
  return `${window.location.origin}/e/${token}`;
}
