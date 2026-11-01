import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { operationIsAdmitted, useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { exposureQuery, sessionQuery, useSession } from '../session/query';
import { PublishedLogPageView, type PublishedLogOrigin } from './log-page';
import { readPublishedLogCurrent } from './logs-server';
import type { PublishedLogCurrentRead, PublishedLogOwner } from './logs-read';

const subscribe = () => () => {};
type Admission = { id: string; active: boolean; allowed: boolean; owner: PublishedLogOwner | null };
const admission = (allowed: boolean): Admission => ({ id: crypto.randomUUID(), active: true, allowed, owner: null });
type OwnerRead = { value: PublishedLogCurrentRead; removeId: string | null; restoreId: string | null };
type Boundary = {
  signature: string;
  active: boolean;
  remove: Admission;
  restore: Admission;
  readId: string;
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

/** Public snapshots survive private retirement. Each write admission has its own non-revivable episode. */
export function CurrentPublishedLog({ loaded, id }: { loaded: PublishedLogCurrentRead; id: string }) {
  const observed = useSession();
  const client = useQueryClient();
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const removeAllowed = useOperation('published_log.delete');
  const restoreAllowed = useOperation('published_log.create');
  const viewer = hydrated
    ? observed.state === 'signed-in'
      ? (observed.subject ?? null)
      : null
    : (loaded.owner?.sessionSubject ?? null);
  const signature = JSON.stringify([
    viewer,
    hydrated ? observed.state : viewer ? 'signed-in' : 'unknown',
    id,
    loaded.log.id === id ? loaded.revision : null,
  ]);
  const boundaryRef = useRef<Boundary | null>(null);
  const [, renderRetired] = useState(0);
  const first = boundaryRef.current === null;
  if (boundaryRef.current?.signature !== signature || !boundaryRef.current.active) {
    if (boundaryRef.current) boundaryRef.current.active = false;
    const remove = admission(!hydrated || removeAllowed);
    const restore = admission(!hydrated || restoreAllowed);
    boundaryRef.current = {
      signature,
      active: true,
      remove,
      restore,
      readId: crypto.randomUUID(),
      ...(first && matches(loaded, viewer, id)
        ? { seed: { value: loaded, removeId: remove.id, restoreId: restore.id } }
        : {}),
    };
  }
  const boundary = boundaryRef.current!;
  for (const [name, allowed] of [
    ['remove', !hydrated || removeAllowed],
    ['restore', !hydrated || restoreAllowed],
  ] as const) {
    const previous = boundary[name];
    if (!previous.active || previous.allowed !== allowed) {
      previous.active = false;
      boundary[name] = admission(allowed);
      // Losing an admission must not refresh/retire the other operation's exact intent.
      // A newly admitted episode needs fresh evidence, rather than the old query's payload.
      if (allowed) boundary.readId = crypto.randomUUID();
      // A previously observed admission cannot be reseeded from the loader, including ABA.
      delete boundary.seed;
    }
  }
  const remove = boundary.remove;
  const restore = boundary.restore;
  function currentViewer() {
    if (boundaryRef.current !== boundary || !boundary.active || !viewer) return false;
    if (!hydrated) return true;
    const now = client.getQueryData(sessionQuery.queryKey);
    return now?.state === 'signed-in' && now.subject === viewer;
  }
  function currentAdmission(value: Admission, operation: 'published_log.delete' | 'published_log.create') {
    return (
      currentViewer() &&
      value.active &&
      value.allowed &&
      (!hydrated || operationIsAdmitted(operation, client.getQueryData(exposureQuery.queryKey)))
    );
  }
  useLayoutEffect(() => {
    boundary.active = true;
    return () => {
      boundary.active = false;
    };
  }, [boundary]);
  useLayoutEffect(() => {
    const observe = () => {
      if (!hydrated || !boundary.active || !viewer) return;
      let retired = false;
      if (!currentViewer()) {
        boundary.active = false;
        retired = true;
      } else {
        const groups = client.getQueryData(exposureQuery.queryKey);
        for (const [value, operation] of [
          [remove, 'published_log.delete'],
          [restore, 'published_log.create'],
        ] as const) {
          if (value.active && value.allowed !== operationIsAdmitted(operation, groups)) {
            value.active = false;
            retired = true;
          }
        }
      }
      if (retired) renderRetired((n) => n + 1);
    };
    const unsubscribe = client.getQueryCache().subscribe(observe);
    observe();
    return () => {
      unsubscribe();
    };
  }, [boundary, remove, restore, client, hydrated]);
  const query = useQuery({
    ...personalRead,
    queryKey: ['published-log-owner', signature, boundary.readId],
    enabled: personalRead.enabled && hydrated && !!viewer && (remove.allowed || restore.allowed),
    initialData: boundary.seed,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      if (!currentViewer()) throw new Error('Published log read retired');
      const needsRemove = !remove.owner && currentAdmission(remove, 'published_log.delete');
      const needsRestore = !restore.owner && currentAdmission(restore, 'published_log.create');
      const value = await readPublishedLogCurrent({ data: { id } });
      if (!currentViewer() || value.requestedId !== id || value.log.id !== id)
        throw new Error('Published log read retired');
      return {
        value,
        removeId: needsRemove && currentAdmission(remove, 'published_log.delete') ? remove.id : null,
        restoreId: needsRestore && currentAdmission(restore, 'published_log.create') ? restore.id : null,
      };
    },
  });
  if (query.data && !query.isError) {
    const owner = matches(query.data.value, viewer, id) ? query.data.value.owner : null;
    if (query.data.removeId === remove.id && currentAdmission(remove, 'published_log.delete')) remove.owner = owner;
    if (query.data.restoreId === restore.id && currentAdmission(restore, 'published_log.create')) restore.owner = owner;
  }
  function operand(value: Admission, operation: 'published_log.delete' | 'published_log.create') {
    const owner = value.owner;
    const isCurrent = () =>
      !!owner &&
      value.owner?.sessionSubject === owner.sessionSubject &&
      value.owner.accountId === owner.accountId &&
      value.owner.id === owner.id &&
      value.owner.revision === owner.revision &&
      currentAdmission(value, operation);
    return {
      lifetime: value,
      isCurrent,
      headers: () => {
        if (!hydrated || !isCurrent()) return null;
        const token = client.getQueryData(sessionQuery.queryKey)?.csrfToken;
        return token ? { 'x-csrf-token': token } : null;
      },
    };
  }
  const originating: PublishedLogOrigin = {
    lifetime: boundary,
    remove: operand(remove, 'published_log.delete'),
    restore: operand(restore, 'published_log.create'),
  };
  const owner =
    (currentAdmission(remove, 'published_log.delete') && remove.owner) ||
    (currentAdmission(restore, 'published_log.create') && restore.owner) ||
    null;
  const log = query.data?.value.log.id === id ? query.data.value.log : loaded.log;
  return (
    <PublishedLogPageView
      log={log}
      isOwner={!!owner}
      {...(owner ? { revision: owner.revision } : {})}
      originating={originating}
    />
  );
}
