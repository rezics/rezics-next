import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { browserObservation, type BrowserObservationSnapshot } from '../../session';

const noSubscribe = () => () => {};
const UNKNOWN_SNAPSHOT: BrowserObservationSnapshot = { state: 'unknown' };
const unknownSnapshot = () => UNKNOWN_SNAPSHOT;

/** Consume the shared browser authority without preparing another request. */
function observeCommunityEnvironment(client: QueryClient | undefined) {
  const observation = client ? browserObservation(client) : undefined;
  return {
    observation,
    snapshot: () => {
      const current = observation?.getSnapshot() ?? unknownSnapshot();
      return JSON.stringify([
        current.state,
        current.state === 'signed-in' ? current.observation.subject : null,
        current.state === 'signed-in' ? current.observation.id : null,
      ]);
    },
    serverSnapshot: () => 'unknown',
    subscribe: observation?.subscribe ?? noSubscribe,
  };
}

type CommunityReadingBinding = {
  source: object | string;
  descriptor: string;
  reader: string | null;
  environment: ReturnType<typeof observeCommunityEnvironment>;
  generation: number;
  retired: boolean;
  privateRetired: boolean;
  observation?: { subject: string; id: number };
};

function initialBinding(
  input: { source: object | string; descriptor: string; reader: string | null },
  environment: ReturnType<typeof observeCommunityEnvironment>,
): CommunityReadingBinding {
  const observed = environment.observation?.getSnapshot() ?? unknownSnapshot();
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
    retired: false,
    privateRetired: settledMismatch,
    ...(matched && observed.state === 'signed-in' ? { observation: observed.observation } : {}),
  };
}

/** Public bodies survive session preparation; private actions bind once to the matching browser observation. */
export function useSubjectCommunityReading(input: {
  source: object | string;
  descriptor: string;
  reader: string | null;
}) {
  const client = useContext(QueryClientContext);
  const environment = useMemo(() => observeCommunityEnvironment(client), [client]);
  useSyncExternalStore(environment.subscribe, environment.snapshot, environment.serverSnapshot);
  const observation = environment.observation?.getSnapshot() ?? unknownSnapshot();
  const [binding, setBinding] = useState(() => initialBinding(input, environment));

  if (binding.source !== input.source) {
    setBinding({ ...initialBinding(input, environment), generation: binding.generation + 1 });
  } else if (
    !binding.retired &&
    (binding.descriptor !== input.descriptor || binding.reader !== input.reader || binding.environment !== environment)
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
        setBinding({ ...binding, privateRetired: true, generation: binding.generation + 1 });
      }
    } else if (
      !binding.privateRetired &&
      (observation.state === 'signed-out' ||
        (observation.state === 'signed-in' && observation.observation.subject !== input.reader))
    ) {
      setBinding({ ...binding, privateRetired: true, generation: binding.generation + 1 });
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
    if (!mounted.current || current.current !== binding || binding.retired) return false;
    return true;
  };
  const privateActionsCurrent = () => {
    if (!isBoundCurrent() || binding.reader === null || binding.privateRetired) return false;
    const now = environment.observation?.getSnapshot() ?? unknownSnapshot();
    return (
      binding.observation !== undefined &&
      now.state === 'signed-in' &&
      now.observation.id === binding.observation.id &&
      now.observation.subject === binding.reader
    );
  };

  return {
    available: !binding.retired,
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
