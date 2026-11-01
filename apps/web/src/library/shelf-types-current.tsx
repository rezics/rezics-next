import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { operationIsAdmitted, useOperation } from '../kernel/exposure';
import { exposureQuery, sessionQuery, useSession } from '../session/query';
import { shelfHref, type ShelfSearch } from './shelf-params';
import { useHydrated } from './shelf-rows';

/** Observe cache/navigation transitions synchronously, including ABA batched before React renders. */
export function useShelfTypesLifetime(locale: string, view: ShelfSearch) {
  const client = useQueryClient();
  const router = useRouter({ warn: false });
  const session = useSession();
  const admitted = useOperation('library_shelf.types');
  const hydrated = useHydrated();
  const observation = useMemo(() => {
    let address = router?.state.location.href ?? null;
    let snapshot = { signature: '', generation: 0 };
    const read = () => {
      const viewer = client.getQueryData(sessionQuery.queryKey);
      const allowed = operationIsAdmitted('library_shelf.types', client.getQueryData(exposureQuery.queryKey));
      const signature = JSON.stringify([viewer?.state ?? 'unknown', viewer?.subject ?? null, allowed, address]);
      if (signature !== snapshot.signature) snapshot = { signature, generation: snapshot.generation + 1 };
      return snapshot;
    };
    return {
      read,
      subscribe(notify: () => void) {
        const cache = client.getQueryCache().subscribe(() => {
          read();
          notify();
        });
        const navigation = router?.subscribe('onBeforeNavigate', ({ toLocation }) => {
          address = toLocation.href;
          read();
          notify();
        });
        return () => {
          cache();
          navigation?.();
        };
      },
    };
  }, [client, router]);
  const observed = useSyncExternalStore(observation.subscribe, observation.read, observation.read);
  const subject = session.state === 'signed-in' && session.subject?.trim() ? session.subject : null;
  const signature = JSON.stringify([session.state, subject, admitted, hydrated, locale, shelfHref(locale, view)]);
  const origin = useRef<{
    signature: string;
    observed: typeof observed;
    generation: number;
    active: boolean;
    mounted: boolean;
  } | null>(null);
  if (!origin.current || origin.current.signature !== signature || origin.current.observed !== observed) {
    const generation = (origin.current?.generation ?? 0) + 1;
    if (origin.current) origin.current.active = false;
    origin.current = { signature, observed, generation, active: true, mounted: false };
  }
  const lifetime = origin.current;
  useLayoutEffect(() => {
    lifetime.mounted = true;
    return () => {
      lifetime.mounted = false;
    };
  }, [lifetime]);
  const isCurrent = () => {
    if (!lifetime.active || !lifetime.mounted || origin.current !== lifetime) return false;
    const viewer = client.getQueryData(sessionQuery.queryKey);
    if (
      !hydrated ||
      !subject ||
      !admitted ||
      viewer?.state !== 'signed-in' ||
      viewer.subject !== subject ||
      !operationIsAdmitted('library_shelf.types', client.getQueryData(exposureQuery.queryKey)) ||
      observation.read() !== observed
    ) {
      lifetime.active = false;
      return false;
    }
    return true;
  };
  return { key: lifetime.generation, subject, admitted, hydrated, isCurrent };
}
