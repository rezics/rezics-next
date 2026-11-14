import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStoreWithSelector } from '../../kernel/use-sync-external-store-with-selector';
import { browserObservation, type BrowserObservationSnapshot } from '../../session';

const noSubscribe = () => () => {};
const UNKNOWN_SNAPSHOT: BrowserObservationSnapshot = { state: 'unknown' };
const unknownSnapshot = () => UNKNOWN_SNAPSHOT;
const STANDALONE_SNAPSHOT = JSON.stringify(['unknown', null, null, true]);
const identityString = (value: string) => value;

function observationRevision(snapshot: BrowserObservationSnapshot) {
  return snapshot.state === 'signed-in' ? snapshot.observation.id : snapshot.state;
}

type CommunityEnvironment = {
  observation: ReturnType<typeof browserObservation> | undefined;
  sourceCurrent: () => boolean;
  snapshot: () => string;
  subscribe: (notify: () => void) => () => void;
};

/**
 * Cache the external-store snapshot until a subscription fires. React compares getSnapshot with
 * Object.is on every paired read; a fresh object or a mutating sourceCurrent() tears and loops.
 * Standalone ReviewList/ThreadList mounts have no QueryClient, so both client and server reads
 * reuse the same cached unknown snapshot. Origin away is fenced by sourceCurrent/isCurrent, never
 * by baking that fence into the snapshot string. Selection changes reuse Commerce's shared
 * useSyncExternalStoreWithSelector so equal snapshots keep the current visit.
 */
function observeCommunityEnvironment(
  client: QueryClient | undefined,
  queryKey?: readonly unknown[],
  reader: string | null = null,
): CommunityEnvironment {
  const observation = client ? browserObservation(client) : undefined;
  const sourceHash = queryKey && client ? client.defaultQueryOptions({ queryKey }).queryHash : undefined;
  const source = sourceHash ? client?.getQueryCache().get(sourceHash) : undefined;
  const count = source?.state.dataUpdateCount;
  let retired = false;
  let prepared: BrowserObservationSnapshot | undefined;
  let exposure: { query: object; count: number } | undefined;
  let cached: string | undefined = observation ? undefined : STANDALONE_SNAPSHOT;
  const sourceCurrent = () => {
    if (retired) return false;
    const now = observation?.getSnapshot() ?? UNKNOWN_SNAPSHOT;
    if (prepared) {
      if (
        now.state !== prepared.state ||
        (prepared.state === 'signed-in' &&
          (now.state !== 'signed-in' || now.observation.id !== prepared.observation.id))
      )
        retired = true;
    } else if (now.state === 'signed-in' || now.state === 'signed-out') {
      // Preparation binds once. Every later incarnation change is a new authority episode,
      // including equal successful credentials and changes coalesced into one React render.
      prepared = now;
      if (reader !== null && (now.state !== 'signed-in' || now.observation.subject !== reader)) retired = true;
    }
    if (retired) return false;
    if (prepared?.state === 'signed-in') {
      const exposureHash = client?.defaultQueryOptions({
        queryKey: ['exposure', 'viewer', prepared.observation.subject, prepared.observation.id],
      }).queryHash;
      const current = exposureHash ? client?.getQueryCache().get(exposureHash) : undefined;
      if (exposure) {
        if (
          current !== exposure.query ||
          current?.state.status !== 'success' ||
          current.state.fetchStatus !== 'idle' ||
          current.state.isInvalidated ||
          current.state.dataUpdateCount !== exposure.count
        )
          retired = true;
      } else if (current?.state.status === 'success' && current.state.fetchStatus === 'idle') {
        if (current.state.isInvalidated) retired = true;
        else exposure = { query: current, count: current.state.dataUpdateCount };
      } else if (current?.state.status === 'error') retired = true;
    }
    if (retired) return false;
    if (!queryKey) return true;
    const current = sourceHash ? client?.getQueryCache().get(sourceHash) : undefined;
    if (
      !current ||
      current !== source ||
      current.state.status !== 'success' ||
      current.state.fetchStatus !== 'idle' ||
      current.state.isInvalidated ||
      current.state.dataUpdateCount !== count
    )
      retired = true;
    return !retired;
  };
  const compute = () => {
    const current = observation?.getSnapshot() ?? UNKNOWN_SNAPSHOT;
    return JSON.stringify([
      current.state,
      current.state === 'signed-in' ? current.observation.subject : null,
      current.state === 'signed-in' ? current.observation.id : null,
      retired,
    ]);
  };
  const snapshot = () => cached ?? (cached = compute());
  const invalidate = (notify: () => void) => {
    cached = observation ? undefined : STANDALONE_SNAPSHOT;
    notify();
  };
  return {
    observation,
    sourceCurrent,
    snapshot,
    subscribe: (notify: () => void) => {
      const stop = observation?.subscribe(() => invalidate(notify)) ?? noSubscribe();
      if (!sourceCurrent()) observation?.publish(() => invalidate(notify));
      // Fence every cache transition in-stack, including fetching/idle and A/B/A in one React batch.
      const stopCache = observation?.subscribeCache((event) => {
        // Unscoped exposure changes cannot prove they belong to initial preparation.
        if (
          event.query.queryKey[0] === 'exposure' &&
          event.query.queryKey[1] === 'viewer' &&
          event.query.queryKey.length === 2 &&
          (event.type === 'removed' ||
            (event.type === 'updated' &&
              ['success', 'error', 'invalidate', 'fetch', 'setState'].includes(event.action.type)))
        )
          retired = true;
        if (!sourceCurrent()) observation.publish(() => invalidate(notify));
      });
      return () => {
        stop();
        stopCache?.();
      };
    },
  };
}

type CommunityReadingBinding = {
  source: object | string;
  descriptor: string;
  reader: string | null;
  environment: CommunityEnvironment;
  generation: number;
  retired: boolean;
  spoiler?: number | undefined;
};

function initialBinding(
  input: { source: object | string; descriptor: string; reader: string | null; spoiler?: number | undefined },
  environment: CommunityEnvironment,
): CommunityReadingBinding {
  return {
    ...input,
    environment,
    generation: 0,
    retired: !environment.sourceCurrent(),
  };
}

/** Initial session preparation preserves public bodies; an admitted reader binds once to its browser observation. */
export function useSubjectCommunityReading(input: {
  source: object | string;
  descriptor: string;
  reader: string | null;
  /** Undefined is conservative initial preparation; the first prepared setting binds this source once. */
  spoiler?: number | undefined;
  queryKey?: readonly unknown[] | undefined;
}) {
  const client = useContext(QueryClientContext);
  // Keep the browser subscription mounted while a new source installs its cache witness.
  const observationStore = client ? browserObservation(client) : undefined;
  useSyncExternalStoreWithSelector(
    observationStore?.subscribe ?? noSubscribe,
    observationStore?.getSnapshot ?? unknownSnapshot,
    observationStore?.getServerSnapshot ?? unknownSnapshot,
    observationRevision,
  );
  const queryIdentity = JSON.stringify(input.queryKey);
  const environment = useMemo(
    () => observeCommunityEnvironment(client, input.queryKey, input.reader),
    [client, queryIdentity, input.source, input.reader],
  );
  useSyncExternalStoreWithSelector(environment.subscribe, environment.snapshot, environment.snapshot, identityString);
  const [binding, setBinding] = useState(() => initialBinding(input, environment));
  const identityMatches =
    binding.source === input.source &&
    binding.descriptor === input.descriptor &&
    binding.reader === input.reader &&
    (binding.spoiler === undefined || binding.spoiler === input.spoiler) &&
    binding.environment === environment;

  if (binding.source !== input.source) {
    setBinding({ ...initialBinding(input, environment), generation: binding.generation + 1 });
  } else if (!binding.retired && (!identityMatches || !environment.sourceCurrent())) {
    setBinding({ ...binding, retired: true, generation: binding.generation + 1 });
  } else if (!binding.retired && binding.spoiler === undefined && input.spoiler !== undefined) {
    // Preparing personal preferences does not remount the public reading or cancel its one pending read.
    setBinding({ ...binding, spoiler: input.spoiler });
  }

  const current = useRef(binding);
  current.current = binding;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isBoundCurrent = () => {
    if (
      !mounted.current ||
      current.current.generation !== binding.generation ||
      binding.retired ||
      !identityMatches ||
      !environment.sourceCurrent()
    )
      return false;
    return true;
  };
  const privateActionsCurrent = () => {
    if (!isBoundCurrent() || binding.reader === null) return false;
    const now = environment.observation?.getSnapshot() ?? UNKNOWN_SNAPSHOT;
    return now.state === 'signed-in' && now.observation.subject === binding.reader;
  };

  return {
    available: !binding.retired && identityMatches && environment.sourceCurrent(),
    key: String(binding.generation),
    isCurrent: isBoundCurrent,
    privateActionsCurrent,
  };
}

/** A visit belongs to one admitted Subject source, reader, Context, route and native reaction target. */
export function useSubjectCommunityLifetime(input: {
  subjectId: string;
  contextId: string | null;
  reader: string | null;
  route: string;
  source: string;
  targetId: string;
  ready: boolean;
  locale?: string;
  credentialEpoch?: string | null;
  exposure?: string;
}) {
  const client = useContext(QueryClientContext);
  const observationStore = client ? browserObservation(client) : undefined;
  const selectObservationId = useCallback(
    (observed: BrowserObservationSnapshot) =>
      observed.state === 'signed-in' && observed.observation.subject === input.reader ? observed.observation.id : null,
    [input.reader],
  );
  const observationId = useSyncExternalStoreWithSelector(
    observationStore?.subscribe ?? noSubscribe,
    observationStore?.getSnapshot ?? unknownSnapshot,
    observationStore?.getServerSnapshot ?? unknownSnapshot,
    selectObservationId,
  );
  const identity = JSON.stringify([
    input.subjectId,
    input.contextId,
    input.reader,
    input.route,
    input.source,
    input.targetId,
    input.ready,
    input.locale,
    input.credentialEpoch,
    input.exposure,
    observationId,
  ]);
  const visit = useRef({ identity, generation: 0, active: false });
  if (visit.current.identity !== identity) {
    visit.current = { identity, generation: visit.current.generation + 1, active: false };
  }
  const owned = visit.current;
  useLayoutEffect(() => {
    owned.active = true;
    return () => {
      // Cleanup belongs to this visit, even when a newer visit has the same URL.
      owned.active = false;
    };
  }, [owned]);
  return {
    key: JSON.stringify([identity, owned.generation]),
    reader: input.reader,
    isCurrent: () => {
      if (!input.ready || visit.current !== owned || !owned.active) return false;
      if (input.reader === null || !observationStore) return true;
      const now = observationStore.getSnapshot();
      return (
        observationId !== null &&
        now.state === 'signed-in' &&
        now.observation.id === observationId &&
        now.observation.subject === input.reader
      );
    },
  };
}
