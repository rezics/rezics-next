import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { personalRead, publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { locateRealmPage, readSpacePage } from './space-actions';
import { useEffect, useRef, useState } from 'react';
import type { ReaderOrigin, ShelfPage } from './space';
import {
  bindRealmPageResult,
  bindSpacePageResult,
  captureStandaloneShelfRead,
  captureSpacePageAdmission,
  ObsoleteSpacePageReadError,
  spacePageAdmissionIsCurrent,
  standaloneShelfReadIsCurrent,
  standaloneShelfReaderMatches,
  type SpacePageAdmission,
  type SpacePageTarget,
} from './space-page-lifetime';
import type { SpacePageLifetime } from './space-page-lifetime';
import type { Located, SpacePageData } from './space';

export type SpacePageQueryResult = { page: SpacePageData; admission: SpacePageAdmission };
export type RealmPageQueryResult = {
  located: Located & { readerOrigin?: ReaderOrigin };
  admission: SpacePageAdmission;
};

/** A failed continuation retains both its window and cursor. Only an explicit restart replaces them. */
export function useShelfList<T extends { id: string }>(
  initial: { items: T[]; next: string | null; unavailable: number; credentialMode: ReadCredentialMode },
  read: (input: {
    cursor?: string;
    credentialMode: ReadCredentialMode;
  }) => Promise<ShelfPage<T> & { readerOrigin?: ReaderOrigin }>,
  lifetime?: SpacePageLifetime | null,
  requireReaderOrigin = false,
) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(initial);
  const [failure, setFailure] = useState<'denied' | 'unavailable' | 'stale' | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const active = useRef<{ token: object; generation: number } | null>(null);
  const visit = useRef(lifetime);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      active.current = null;
    };
  }, []);
  useEffect(() => {
    if (visit.current === lifetime) return;
    visit.current = lifetime;
    generation.current++;
    active.current = null;
    setPage(initial);
    setFailure(null);
    setBusy(false);
  }, [lifetime]);
  const canPublish = () => mounted.current && (!lifetime || lifetime.current());
  async function load(restart = false) {
    const previous = active.current;
    if (!canPublish() || (previous && previous.generation === generation.current) || (!restart && !page.next)) return;
    const shelfTicket = lifetime
      ? lifetime.captureShelfRead()
      : requireReaderOrigin
        ? captureStandaloneShelfRead(queryClient, page.credentialMode)
        : null;
    if ((lifetime || requireReaderOrigin) && !shelfTicket) return;
    const request = { token: {}, generation: generation.current };
    active.current = request;
    const started = generation.current;
    const ticket = lifetime?.ticket();
    let settled = false;
    const owns = () =>
      mounted.current &&
      started === generation.current &&
      (active.current === request || (settled && active.current === null)) &&
      (!lifetime ||
        (ticket !== undefined &&
          shelfTicket !== null &&
          lifetime.owns(ticket) &&
          lifetime.shelfReadOwns(shelfTicket))) &&
      (!requireReaderOrigin || !!lifetime || (!!shelfTicket && standaloneShelfReadIsCurrent(shelfTicket)));
    if (!owns()) {
      if (active.current === request) active.current = null;
      return;
    }
    setBusy((previous) => (owns() ? true : previous));
    try {
      if (!owns()) return;
      const result = await read({
        credentialMode: page.credentialMode,
        ...(!restart && page.next ? { cursor: page.next } : {}),
      });
      if (!owns()) return;
      const readerOrigin = result.readerOrigin;
      if (
        (requireReaderOrigin && !readerOrigin) ||
        (readerOrigin && lifetime && (!shelfTicket || !lifetime.shelfReaderMatches(shelfTicket, readerOrigin))) ||
        (readerOrigin &&
          requireReaderOrigin &&
          !lifetime &&
          (!shelfTicket || !standaloneShelfReaderMatches(shelfTicket, readerOrigin)))
      ) {
        setFailure((previous) => (owns() ? 'unavailable' : previous));
        return;
      }
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
      const stillOwns = owns();
      settled = stillOwns;
      if (active.current === request) active.current = null;
      if (stillOwns) setBusy(false);
    }
  }
  function update(change: (previous: typeof initial) => typeof initial) {
    if (!canPublish()) return;
    generation.current += 1;
    setBusy(false);
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
      const admission = originalAdmission ?? captureSpacePageAdmission(client, { target, locale, credentialMode });
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      const page = await readSpacePage({ data: { address, credentialMode } });
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      const bound = bindSpacePageResult(page, admission, page.readerOrigin, client);
      if (!bound) throw new ObsoleteSpacePageReadError();
      return { page, admission: bound } satisfies SpacePageQueryResult;
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
      const admission = originalAdmission ?? captureSpacePageAdmission(client, { target, locale, credentialMode });
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      const located = await locateRealmPage({ data: { realmId: id, credentialMode } });
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      const bound = bindRealmPageResult(located, admission, client);
      if (!bound) throw new ObsoleteSpacePageReadError();
      return { located, admission: bound } satisfies RealmPageQueryResult;
    },
  });
