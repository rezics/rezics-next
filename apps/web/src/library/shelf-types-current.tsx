import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import { useSession } from '../session';
import { shelfHref, type ShelfSearch } from './shelf-params';
import { useHydrated } from './shelf-rows';

const operations = ['library_shelf.types'] as const;

/** Observe cache/navigation transitions synchronously, including ABA batched before React renders. */
export function useShelfTypesLifetime(locale: string, view: ShelfSearch) {
  const { store, value } = useLibraryWorkspaceAdmission(operations);
  const router = useRouter({ warn: false });
  useSession();
  const admitted = value.allowed[0] === true;
  const hydrated = useHydrated();
  const observation = useMemo(() => {
    let address = router?.state.location.href ?? null;
    let snapshot = { signature: '', generation: 0 };
    const read = () => {
      const scoped = store.read();
      const signature = JSON.stringify([
        scoped.subject,
        scoped.viewer,
        scoped.allowed[0],
        scoped.episodes[0],
        scoped.observation?.id,
        address,
      ]);
      if (signature !== snapshot.signature) snapshot = { signature, generation: snapshot.generation + 1 };
      return snapshot;
    };
    return {
      read,
      subscribe(notify: () => void) {
        const cache = store.watch(() => {
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
  }, [store, router]);
  const observed = useSyncExternalStore(observation.subscribe, observation.read, observation.read);
  const subject = value.subject;
  const signature = JSON.stringify([subject, admitted, hydrated, locale, shelfHref(locale, view)]);
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
    if (lifetime.active) lifetime.mounted = true;
    return () => {
      lifetime.mounted = false;
    };
  }, [lifetime]);
  const isCurrent = () => {
    if (!lifetime.active || !lifetime.mounted || origin.current !== lifetime) return false;
    const viewer = store.read();
    if (
      !hydrated ||
      !subject ||
      !admitted ||
      viewer.subject !== subject ||
      !store.allowed('library_shelf.types') ||
      observation.read() !== observed
    ) {
      lifetime.active = false;
      return false;
    }
    return true;
  };
  return { key: lifetime.generation, subject, admitted, hydrated, isCurrent };
}
