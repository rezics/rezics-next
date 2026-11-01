import { queryOptions } from '@tanstack/react-query';
import { personalRead, publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { locateRealmPage, readSpacePage } from './space-actions';
import { useEffect, useRef, useState } from 'react';
import type { ShelfPage } from './space';
import {
  bindRealmPageResult,
  bindSpacePageResult,
  captureSpacePageAdmission,
  ObsoleteSpacePageReadError,
  spacePageAdmissionIsCurrent,
  type SpacePageAdmission,
  type SpacePageTarget,
} from './space-page-lifetime';
import type { SpacePageLifetime } from './space-page-lifetime';

/** A failed continuation retains both its window and cursor. Only an explicit restart replaces them. */
export function useShelfList<T extends { id: string }>(
  initial: { items: T[]; next: string | null; unavailable: number; credentialMode: ReadCredentialMode },
  read: (input: { cursor?: string; credentialMode: ReadCredentialMode }) => Promise<ShelfPage<T>>,
  lifetime?: SpacePageLifetime | null,
) {
  const [page, setPage] = useState(initial);
  const [failure, setFailure] = useState<'denied' | 'unavailable' | 'stale' | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const canPublish = () => mounted.current && (!lifetime || lifetime.current());
  async function load(restart = false) {
    if (!canPublish() || running.current || (!restart && !page.next)) return;
    running.current = true;
    const started = generation.current;
    const ticket = lifetime?.ticket();
    const owns = () =>
      mounted.current &&
      started === generation.current &&
      (!lifetime || (ticket !== undefined && lifetime.owns(ticket)));
    setBusy((previous) => (owns() ? true : previous));
    try {
      if (!owns()) return;
      const result = await read({
        credentialMode: page.credentialMode,
        ...(!restart && page.next ? { cursor: page.next } : {}),
      });
      if (!owns()) return;
      if (result.kind !== 'page') {
        setFailure((previous) => (owns() ? result.kind : previous));
        if (result.kind === 'denied' && owns())
          setPage((previous) => (owns() ? { ...previous, items: [], unavailable: 0 } : previous));
        return;
      }
      setFailure((previous) => (owns() ? null : previous));
      setPage((previous) => {
        if (!owns()) return previous;
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
      setFailure((previous) => (owns() ? 'unavailable' : previous));
    } finally {
      running.current = false;
      setBusy((previous) => (owns() ? false : previous));
    }
  }
  function update(change: (previous: typeof initial) => typeof initial) {
    if (!canPublish()) return;
    generation.current += 1;
    const ticket = lifetime?.ticket();
    setPage((previous) => {
      if (!mounted.current) return previous;
      if (lifetime && (ticket === undefined || !lifetime.owns(ticket))) return previous;
      return change(previous);
    });
  }
  return { ...page, failure, busy, load, update };
}

export const spaceQuery = (
  address: string,
  locale: string,
  credentialMode: ReadCredentialMode,
  originalAdmission?: SpacePageAdmission,
) =>
  queryOptions({
    ...(credentialMode === 'session' ? personalRead : publicRead),
    queryKey: readQueryKey(['space', address, locale], credentialMode),
    queryFn: async ({ client }) => {
      const target: SpacePageTarget = { kind: 'space', address };
      const admission =
        originalAdmission ?? captureSpacePageAdmission(client, { target, locale, credentialMode });
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      const page = await readSpacePage({ data: { address, credentialMode } });
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      bindSpacePageResult(page, admission);
      return page;
    },
  });

export const realmPageQuery = (
  id: string,
  locale: string,
  credentialMode: ReadCredentialMode,
  originalAdmission?: SpacePageAdmission,
) =>
  queryOptions({
    ...(credentialMode === 'session' ? personalRead : publicRead),
    queryKey: readQueryKey(['realm-page', id, locale], credentialMode),
    queryFn: async ({ client }) => {
      const target: SpacePageTarget = { kind: 'realm', id };
      const admission =
        originalAdmission ?? captureSpacePageAdmission(client, { target, locale, credentialMode });
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      const located = await locateRealmPage({ data: { realmId: id, credentialMode } });
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      if (located.kind === 'page') bindSpacePageResult(located.page, admission);
      bindRealmPageResult(located, admission);
      return located;
    },
  });
