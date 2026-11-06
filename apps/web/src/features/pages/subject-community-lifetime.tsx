import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { browserObservation, type BrowserObservationSnapshot } from '../../session';

const noSubscribe = () => () => {};
const UNKNOWN_SNAPSHOT: BrowserObservationSnapshot = { state: 'unknown' };
const unknownSnapshot = () => UNKNOWN_SNAPSHOT;
const STANDALONE_SNAPSHOT = JSON.stringify(['unknown', null, null, true]);

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
 * reuse the same cached unknown snapshot.
 */
function observeCommunityEnvironment(client: QueryClient | undefined, queryKey?: readonly unknown[]): CommunityEnvironment {
  const observation = client ? browserObservation(client) : undefined;
  const source = queryKey && client ? client.getQueryCache().find({ queryKey, exact: true }) : undefined;
  const count = source?.state.dataUpdateCount;
  let retired = false;
  let cached: string | undefined = observation ? undefined : STANDALONE_SNAPSHOT;
  const sourceCurrent = () => {
    if (retired) return false;
    if (!queryKey) return true;
    const current = client?.getQueryCache().find({ queryKey, exact: true });
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
      sourceCurrent(),
    ]);
  };
  const snapshot = () => (cached ??= compute());
  const invalidate = (notify: () => void) => {
    cached = undefined;
    notify();
  };
  return {
    observation,
    sourceCurrent,
    snapshot,
    subscribe: (notify: () => void) => {
      const stop = observation?.subscribe(() => invalidate(notify)) ?? noSubscribe();
      // Fence every cache transition in-stack, including fetching/idle and A/B/A in one React batch.
      const stopCache = observation?.subscribeCache(() => {
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
  privateRetired: boolean;
  observation?: { subject: string; id: number };
};

function initialBinding(
  input: { source: object | string; descriptor: string; reader: string | null },
  environment: CommunityEnvironment,
): CommunityReadingBinding {
  const observed = environment.observation?.getSnapshot() ?? UNKNOWN_SNAPSHOT;
  const matched =
    input.reader !== null && observed.state === 'signed-in' && observed.observation.subject === input.reader;
  const settledMismatch =
    input.reader !== null &&
    (observed.state === 'signed-out' ||
      (observed.state === 'signed-in' && observed.observation.subject !== input.reader));
  return {
    ...input,
    environment,
    generation: 0,
    retired: settledMismatch,
    privateRetired: settledMismatch,
    ...(matched && observed.state === 'signed-in' ? { observation: observed.observation } : {}),
  };
}

/** Initial session preparation preserves public bodies; an admitted reader binds once to its browser observation. */
export function useSubjectCommunityReading(input: {
  source: object | string;
  descriptor: string;
  reader: string | null;
  queryKey?: readonly unknown[] | undefined;
}) {
  const client = useContext(QueryClientContext);
  // Keep the browser subscription mounted while a new source installs its cache witness.
  const observationStore = client ? browserObservation(client) : undefined;
  useSyncExternalStore(
    observationStore?.subscribe ?? noSubscribe,
    observationStore?.getSnapshot ?? unknownSnapshot,
    observationStore?.getServerSnapshot ?? unknownSnapshot,
  );
  const queryIdentity = JSON.stringify(input.queryKey);
  const environment = useMemo(
    () => observeCommunityEnvironment(client, input.queryKey),
    [client, queryIdentity, input.source],
  );
  useSyncExternalStore(environment.subscribe, environment.snapshot, environment.snapshot);
  const observation = environment.observation?.getSnapshot() ?? UNKNOWN_SNAPSHOT;
  const [binding, setBinding] = useState(() => initialBinding(input, environment));

  if (binding.source !== input.source) {
    setBinding({ ...initialBinding(input, environment), generation: binding.generation + 1 });
  } else if (
    !binding.retired &&
    (binding.descriptor !== input.descriptor ||
      binding.reader !== input.reader ||
      binding.environment !== environment ||
      !environment.sourceCurrent())
  ) {
    setBinding({ ...binding, retired: true, generation: binding.generation + 1 });
  } else if (!binding.retired && input.reader !== null) {
    if (binding.observation) {
      if (
        !binding.privateRetired &&
        (observation.state !== 'signed-in' ||
          observation.observation.id !== binding.observation.id ||
          observation.observation.subject !== binding.observation.subject)
      ) {
        setBinding({ ...binding, retired: true, privateRetired: true, generation: binding.generation + 1 });
      }
    } else if (
      !binding.privateRetired &&
      (observation.state === 'signed-out' ||
        (observation.state === 'signed-in' && observation.observation.subject !== input.reader))
    ) {
      setBinding({ ...binding, retired: true, privateRetired: true, generation: binding.generation + 1 });
    } else if (
      !binding.privateRetired &&
      observation.state === 'signed-in' &&
      observation.observation.subject === input.reader
    ) {
      setBinding({
        ...binding,
        observation: observation.observation,
        generation: binding.generation + 1,
      });
    }
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
    if (!mounted.current || current.current !== binding || binding.retired || !environment.sourceCurrent())
      return false;
    if (binding.observation) {
      const now = environment.observation?.getSnapshot() ?? UNKNOWN_SNAPSHOT;
      if (
        now.state !== 'signed-in' ||
        now.observation.id !== binding.observation.id ||
        now.observation.subject !== binding.observation.subject
      )
        return false;
    }
    return true;
  };
  const privateActionsCurrent = () => {
    if (!isBoundCurrent() || binding.reader === null || binding.privateRetired) return false;
    const now = environment.observation?.getSnapshot() ?? UNKNOWN_SNAPSHOT;
    return (
      binding.observation !== undefined &&
      now.state === 'signed-in' &&
      now.observation.id === binding.observation.id &&
      now.observation.subject === binding.reader
    );
  };

  return {
    available: !binding.retired && environment.sourceCurrent(),
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
  const observed = useSyncExternalStore(
    observationStore?.subscribe ?? noSubscribe,
    observationStore?.getSnapshot ?? unknownSnapshot,
    observationStore?.getServerSnapshot ?? unknownSnapshot,
  );
  const observationId =
    observed.state === 'signed-in' && observed.observation.subject === input.reader ? observed.observation.id : null;
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
