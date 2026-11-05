import { createContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useRouterState } from '@tanstack/react-router';
import type { ShelfOrigin } from './personal-shelf-origin';
import { readShelfSummaryCurrent } from './shelf-summary-read';
import { shelfSummaryObservation, type ShelfSummaryState } from './shelf-summary-observation';

export const ShelfSummaryAcknowledgement = createContext<(() => void) | undefined>(undefined);
const denied: ShelfSummaryState = { state: 'denied' };
const preparing: ShelfSummaryState = { state: 'preparing' };

/** Shares Entry-list admission with the route; progress authority never owns summary counts. */
export function useShelfSummaryCurrent(
  origin: ShelfOrigin,
  subject: string | null,
  type: string | null,
  locale: string,
  hydrated: boolean,
) {
  const href = useRouterState({ select: (state) => state.location.publicHref });
  const source = hydrated ? new URL(href, window.location.href).href : '';
  const epoch = origin.version('library_entry.list');
  const observation = useMemo(() => {
    const admitted = origin.capture('library_entry.list');
    return {
      admitted,
      ...shelfSummaryObservation(
        { subject: subject ?? '', type, locale, source },
        () => !!subject && admitted(),
        () => readShelfSummaryCurrent({ data: type ? { type } : {} }),
      ),
    };
  }, [origin, subject, type, locale, source, epoch]);
  const page = useSyncExternalStore(observation.subscribe, observation.snapshot, () => preparing);
  useEffect(() => {
    if (hydrated) void observation.start();
  }, [hydrated, observation]);
  return {
    page: !hydrated ? preparing : observation.admitted() ? page : denied,
    retry: observation.refresh,
    acknowledge: observation.invalidate,
  };
}
