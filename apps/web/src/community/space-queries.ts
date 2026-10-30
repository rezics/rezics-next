import { queryOptions } from '@tanstack/react-query';
import { personalRead, publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { locateRealmPage, readSpacePage } from './space-actions';
import { useRef, useState } from 'react';
import type { ShelfPage } from './space';

/** A failed continuation retains both its window and cursor. Only an explicit restart replaces them. */
export function useShelfList<T extends { id: string }>(
  initial: { items: T[]; next: string | null; unavailable: number; credentialMode: ReadCredentialMode },
  read: (input: { cursor?: string; credentialMode: ReadCredentialMode }) => Promise<ShelfPage<T>>,
) {
  const [page, setPage] = useState(initial);
  const [failure, setFailure] = useState<'denied' | 'unavailable' | 'stale' | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const generation = useRef(0);
  async function load(restart = false) {
    if (running.current || (!restart && !page.next)) return;
    running.current = true;
    setBusy(true);
    const started = generation.current;
    try {
      const result = await read({
        credentialMode: page.credentialMode,
        ...(!restart && page.next ? { cursor: page.next } : {}),
      });
      if (started !== generation.current) return;
      if (result.kind !== 'page') {
        setFailure(result.kind);
        if (result.kind === 'denied') setPage((previous) => ({ ...previous, items: [], unavailable: 0 }));
        return;
      }
      setFailure(null);
      setPage((previous) => {
        const items = new Map((restart ? [] : previous.items).map((item) => [item.id, item]));
        for (const item of result.items) items.set(item.id, item);
        return {
          ...previous,
          items: [...items.values()],
          next: result.next,
          unavailable: (restart ? 0 : previous.unavailable) + result.unavailable,
        };
      });
    } catch {
      if (started === generation.current) setFailure('unavailable');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function update(change: (previous: typeof initial) => typeof initial) {
    generation.current += 1;
    setPage(change);
  }
  return { ...page, failure, busy, load, update };
}

export const spaceQuery = (address: string, locale: string, credentialMode: ReadCredentialMode) =>
  queryOptions({
    ...(credentialMode === 'session' ? personalRead : publicRead),
    queryKey: readQueryKey(['space', address, locale], credentialMode),
    queryFn: () => readSpacePage({ data: { address, credentialMode } }),
  });

export const realmPageQuery = (id: string, locale: string, credentialMode: ReadCredentialMode) =>
  queryOptions({
    ...(credentialMode === 'session' ? personalRead : publicRead),
    queryKey: readQueryKey(['realm-page', id, locale], credentialMode),
    queryFn: () => locateRealmPage({ data: { realmId: id, credentialMode } }),
  });
