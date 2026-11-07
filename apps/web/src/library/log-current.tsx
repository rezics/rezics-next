import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../session/reading-policy';
import { getLocale } from '../paraglide/runtime.js';
import { PublishedLogPageView, type PublishedLogOrigin } from './log-page';
import { readPublishedLogCurrent } from './logs-server';
import type { PublishedLogCurrentRead, PublishedLogOwner } from './logs-read';
import { useReadingAuthority, type ReadingAdmission } from './reading-detail-current-origin';

const operations = ['published_log.delete', 'published_log.create'] as const;
type Evidence = {
  lease: ReadingAdmission;
  owner: PublishedLogOwner;
  query: object;
  version: number;
  retired: boolean;
};
type OwnerRead = { value: PublishedLogCurrentRead; removeId: string | null; restoreId: string | null };
type Boundary = {
  signature: string;
  identity: object;
  active: boolean;
  remove?: Evidence;
  restore?: Evidence;
  seed?: OwnerRead;
};

function matches(value: PublishedLogCurrentRead | undefined, viewer: string | null, id: string) {
  const owner = value?.owner;
  return Boolean(
    viewer &&
    value?.requestedId === id &&
    value.log.id === id &&
    value.isOwner &&
    owner?.sessionSubject === viewer &&
    owner.accountId === viewer &&
    owner.id === id &&
    owner.revision === value.revision,
  );
}

/** Explicitly public snapshots are independent of the two owner operation episodes. */
export function CurrentPublishedLog({ loaded, id }: { loaded: PublishedLogCurrentRead; id: string }) {
  const { client, browser, store, snapshot } = useReadingAuthority(operations);
  const viewer = browser ? snapshot.viewer : (loaded.owner?.sessionSubject ?? null);
  const locale = getLocale();
  const signature = JSON.stringify([browser ? snapshot.owner : viewer, id, locale]);
  const ref = useRef<Boundary | null>(null);
  const seeded = useRef(false);
  const mounted = useRef(0);
  if (
    !ref.current ||
    !ref.current.active ||
    ref.current.signature !== signature ||
    ref.current.identity !== snapshot.identity
  ) {
    if (ref.current) ref.current.active = false;
    const seed = (!browser || (!seeded.current && snapshot.ready)) && matches(loaded, viewer, id);
    if (browser && snapshot.viewer && snapshot.ready) seeded.current = true;
    ref.current = {
      signature,
      identity: snapshot.identity,
      active: true,
      ...(seed
        ? {
            seed: {
              value: loaded,
              removeId: snapshot.admissions.get(operations[0])?.id ?? null,
              restoreId: snapshot.admissions.get(operations[1])?.id ?? null,
            },
          }
        : {}),
    };
  }
  const boundary = ref.current;
  if (browser && snapshot.viewer && snapshot.ready && !seeded.current) {
    seeded.current = true;
    if (matches(loaded, viewer, id))
      boundary.seed = {
        value: loaded,
        removeId: snapshot.admissions.get(operations[0])?.id ?? null,
        restoreId: snapshot.admissions.get(operations[1])?.id ?? null,
      };
  }
  useLayoutEffect(() => {
    mounted.current++;
    return () => {
      mounted.current--;
    };
  }, []);
  const owns = () =>
    ref.current === boundary &&
    boundary.active &&
    getLocale() === locale &&
    store.read().identity === boundary.identity;
  const remove = snapshot.admissions.get(operations[0]);
  const restore = snapshot.admissions.get(operations[1]);
  const currentAdmission = (lease: ReadingAdmission | undefined, index: 0 | 1) =>
    !!lease &&
    owns() &&
    store.current(snapshot, [operations[index]]) &&
    store.read().admissions.get(operations[index]) === lease;
  const queryKey = ['published-log-owner', signature, remove?.id, restore?.id] as const;
  const needsRemove = currentAdmission(remove, 0) && boundary.remove?.lease !== remove;
  const needsRestore = currentAdmission(restore, 1) && boundary.restore?.lease !== restore;
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled: personalRead.enabled && browser && !!viewer && (needsRemove || needsRestore),
    initialData:
      boundary.seed?.removeId === remove?.id && boundary.seed?.restoreId === restore?.id ? boundary.seed : undefined,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async (): Promise<OwnerRead> => {
      if (!owns() || !snapshot.ready || (!needsRemove && !needsRestore)) throw new Error('Published log read retired');
      const value = await readPublishedLogCurrent({ data: { id } });
      if (!owns() || !store.current(snapshot, []) || value.requestedId !== id || value.log.id !== id)
        throw new Error('Published log read retired');
      return {
        value,
        removeId: needsRemove && currentAdmission(remove, 0) ? remove!.id : null,
        restoreId: needsRestore && currentAdmission(restore, 1) ? restore!.id : null,
      };
    },
  });
  const actualQuery = client.getQueryCache().find({ queryKey, exact: true });
  const actualState = client.getQueryState<OwnerRead>(queryKey);
  // Each operand retains its same actual point read. A read requested by the other
  // admission cannot overwrite this evidence, including with a different revision.
  if (actualQuery && actualState?.status === 'success' && query.data && matches(query.data.value, viewer, id)) {
    const accept = (
      name: 'remove' | 'restore',
      lease: ReadingAdmission | undefined,
      index: 0 | 1,
      sourceId: string | null,
    ) => {
      const previous = boundary[name];
      if (!lease || sourceId !== lease.id || !currentAdmission(lease, index)) return;
      if (
        previous?.lease === lease &&
        previous.query === actualQuery &&
        previous.version === actualState.dataUpdateCount
      )
        return;
      if (previous) previous.retired = true;
      boundary[name] = {
        lease,
        owner: query.data!.value.owner!,
        query: actualQuery,
        version: actualState.dataUpdateCount,
        retired: false,
      };
    };
    accept('remove', remove, 0, query.data.removeId);
    accept('restore', restore, 1, query.data.restoreId);
  }
  const [, renderRetired] = useState(0);
  const evidenceIsCurrent = (value: Evidence) => {
    if (value.retired) return false;
    const admissions = store.read().admissions;
    // The UI intentionally stops observing a key when one admission changes.
    // Its other operand still owns its original successful point-read evidence.
    if (
      queryKey[2] !== admissions.get(operations[0])?.id ||
      queryKey[3] !== admissions.get(operations[1])?.id ||
      value.query !== actualQuery
    )
      return true;
    const actual = client.getQueryCache().find({ queryKey, exact: true });
    const state = client.getQueryState<OwnerRead>(queryKey);
    if (
      actual === value.query &&
      state?.status === 'success' &&
      state.dataUpdateCount === value.version &&
      matches(state.data?.value, viewer, id)
    )
      return true;
    value.retired = true;
    return false;
  };
  useLayoutEffect(() => {
    const observe = () => {
      let retired = false;
      for (const value of [boundary.remove, boundary.restore]) {
        if (value && !value.retired && !evidenceIsCurrent(value)) retired = true;
      }
      if (retired) renderRetired((value) => value + 1);
    };
    const release = client.getQueryCache().subscribe(observe);
    observe();
    return release;
  }, [boundary, client, actualQuery, remove, restore, viewer, id]);
  const removeObservation = useMemo(
    () => ({ observation: snapshot.observation, evidence: boundary.remove }),
    [snapshot.observation, boundary.remove, boundary.remove?.retired],
  );
  const restoreObservation = useMemo(
    () => ({ observation: snapshot.observation, evidence: boundary.restore }),
    [snapshot.observation, boundary.restore, boundary.restore?.retired],
  );
  function operand(value: ReadingAdmission | undefined, index: 0 | 1) {
    const evidence = index === 0 ? boundary.remove : boundary.restore;
    const owner = evidence?.owner;
    const isCurrent = () =>
      mounted.current > 0 &&
      !!evidence &&
      !!owner &&
      evidence.lease === value &&
      evidenceIsCurrent(evidence) &&
      (index === 0 ? boundary.remove : boundary.restore) === evidence &&
      currentAdmission(value, index) &&
      store.current(snapshot, [operations[index]], true);
    return {
      lifetime: value ?? boundary,
      observation: index === 0 ? removeObservation : restoreObservation,
      isCurrent,
      headers: () => (isCurrent() ? store.headers(snapshot, [operations[index]]) : null),
    };
  }
  const originating: PublishedLogOrigin = {
    lifetime: boundary,
    remove: operand(remove, 0),
    restore: operand(restore, 1),
  };
  // Retain the owner editor's custody during an authority pause. The operands alone
  // admit actions; this flag never grants either operation.
  const owner = boundary.remove?.owner ?? boundary.restore?.owner;
  const publicSnapshot = useRef<{ id: string; log: PublishedLogCurrentRead['log'] }>({ id, log: loaded.log });
  if (publicSnapshot.current.id !== id) publicSnapshot.current = { id, log: loaded.log };
  if (query.data?.value.requestedId === id && query.data.value.log.id === id)
    publicSnapshot.current = { id, log: query.data.value.log };
  const log =
    publicSnapshot.current.log.id === id ? publicSnapshot.current.log : loaded.log.id === id ? loaded.log : null;
  if (!log) return null;
  return (
    <PublishedLogPageView
      log={log}
      isOwner={!!owner}
      {...(owner ? { revision: owner.revision } : {})}
      originating={originating}
      sessionSubject={viewer}
    />
  );
}
