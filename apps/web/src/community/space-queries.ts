import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { personalRead, publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { locateRealmPage, readSpacePage } from './space-actions';
import { useEffect, useRef, useState } from 'react';
import type { ReaderOrigin, ShelfPage } from './space';
import {
  allowSpacePageQueryRetry,
  bindRealmPageResult,
  bindSpacePageResult,
  captureStandaloneShelfRead,
  captureSpacePageAdmission,
  beginSpacePageQueryRead,
  ObsoleteSpacePageReadError,
  recordSpacePageQueryResult,
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

type ShelfRead = { restart: boolean; cursor: string | null };
type FailedShelfRead = ShelfRead & { kind: 'denied' | 'unavailable' | 'stale' };

export type ShelfContinuationResult = {
  intent: object | undefined;
  firstId: string | null;
  count: number;
  current: () => boolean;
};

/** A failed read retains its admitted window and request; a successful restart replaces the window. */
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
  const [page, setPage] = useState({ ...initial, continuation: null as ShelfContinuationResult | null });
  const [failedRead, setFailedRead] = useState<FailedShelfRead | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const active = useRef<{ token: object; generation: number } | null>(null);
  const latestRead = useRef<object | null>(null);
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
    setPage({ ...initial, continuation: null });
    setFailedRead(null);
    setBusy(false);
  }, [lifetime]);
  const canPublish = () => mounted.current && (!lifetime || lifetime.current());
  async function requestPage({ restart, cursor }: ShelfRead, intent?: object) {
    const previous = active.current;
    if (!canPublish() || (previous && previous.generation === generation.current)) return;
    const shelfTicket = lifetime
      ? lifetime.captureShelfRead()
      : requireReaderOrigin
        ? captureStandaloneShelfRead(queryClient, page.credentialMode)
        : null;
    if ((lifetime || requireReaderOrigin) && !shelfTicket) return;
    const request = { token: {}, generation: generation.current };
    active.current = request;
    latestRead.current = request;
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
    const current = () => owns() && latestRead.current === request;
    const fail = (kind: FailedShelfRead['kind']) => {
      setFailedRead((previous) => (owns() ? { kind, restart, cursor } : previous));
      setPage((previous) =>
        owns() ? { ...previous, continuation: { intent, firstId: null, count: 0, current } } : previous,
      );
    };
    if (!owns()) {
      if (active.current === request) active.current = null;
      return;
    }
    setBusy((previous) => (owns() ? true : previous));
    try {
      if (!owns()) return;
      const result = await read({
        credentialMode: page.credentialMode,
        ...(cursor ? { cursor } : {}),
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
        fail('unavailable');
        return;
      }
      if (result.kind !== 'page') {
        fail(result.kind);
        if (result.kind === 'denied' && owns())
          setPage((previous) => (owns() ? { ...previous, items: [], unavailable: 0 } : previous));
        return;
      }
      setFailedRead((previous) => (owns() ? null : previous));
      setPage((previous) => {
        if (!owns()) return previous;
        const items = new Map((restart ? [] : previous.items).map((item) => [item.id, item]));
        let firstId: string | null = null;
        let count = 0;
        // Inspect only this accepted native page; existing entries do not count as additions.
        for (const item of result.items) {
          if (!items.has(item.id)) {
            firstId ??= item.id;
            count++;
          }
          items.set(item.id, item);
        }
        return {
          ...previous,
          items: [...items.values()],
          next: result.next,
          unavailable: (restart ? 0 : previous.unavailable) + result.unavailable,
          continuation: { intent, firstId, count, current },
        };
      });
    } catch {
      fail('unavailable');
    } finally {
      const stillOwns = owns();
      settled = stillOwns;
      if (active.current === request) active.current = null;
      if (stillOwns) setBusy(false);
    }
  }
  function load(restart = false, intent?: object) {
    if (!restart && !page.next) return Promise.resolve();
    return requestPage({ restart, cursor: restart ? null : page.next }, intent);
  }
  function retry(intent?: object) {
    if (!failedRead) return Promise.resolve();
    return requestPage(failedRead, intent);
  }
  function update(change: (previous: typeof initial) => typeof initial) {
    if (!canPublish()) return;
    generation.current += 1;
    setBusy(false);
    const ticket = lifetime?.ticket();
    setPage((previous) => {
      if (!mounted.current) return previous;
      if (lifetime && (ticket === undefined || !lifetime.owns(ticket))) return previous;
      return { ...change(previous), continuation: null };
    });
  }
  return { ...page, failure: failedRead?.kind ?? null, busy, load, retry, update };
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
    queryFn: async ({ client, signal }) => {
      const target: SpacePageTarget = { kind: 'space', address };
      const admission = originalAdmission ?? captureSpacePageAdmission(client, { target, locale, credentialMode });
      if (
        !beginSpacePageQueryRead(admission, client, readQueryKey(['space', address, locale], credentialMode), signal) ||
        !spacePageAdmissionIsCurrent(admission, client)
      )
        throw new ObsoleteSpacePageReadError();
      let page: Awaited<ReturnType<typeof readSpacePage>>;
      try {
        page = await readSpacePage({ data: { address, credentialMode } });
      } catch (error) {
        if (!(error instanceof ObsoleteSpacePageReadError)) allowSpacePageQueryRetry(admission);
        throw error;
      }
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      const bound = bindSpacePageResult(page, admission, page.readerOrigin, client);
      if (!bound) throw new ObsoleteSpacePageReadError();
      const result = { page, admission: bound } satisfies SpacePageQueryResult;
      if (!recordSpacePageQueryResult(admission, result)) throw new ObsoleteSpacePageReadError();
      return result;
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
    queryFn: async ({ client, signal }) => {
      const target: SpacePageTarget = { kind: 'realm', id };
      const admission = originalAdmission ?? captureSpacePageAdmission(client, { target, locale, credentialMode });
      if (
        !beginSpacePageQueryRead(admission, client, readQueryKey(['realm-page', id, locale], credentialMode), signal) ||
        !spacePageAdmissionIsCurrent(admission, client)
      )
        throw new ObsoleteSpacePageReadError();
      let located: Awaited<ReturnType<typeof locateRealmPage>>;
      try {
        located = await locateRealmPage({ data: { realmId: id, credentialMode } });
      } catch (error) {
        if (!(error instanceof ObsoleteSpacePageReadError)) allowSpacePageQueryRetry(admission);
        throw error;
      }
      if (!spacePageAdmissionIsCurrent(admission, client)) throw new ObsoleteSpacePageReadError();
      const bound = bindRealmPageResult(located, admission, client);
      if (!bound) throw new ObsoleteSpacePageReadError();
      const result = { located, admission: bound } satisfies RealmPageQueryResult;
      if (!recordSpacePageQueryResult(admission, result)) throw new ObsoleteSpacePageReadError();
      return result;
    },
  });
