import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { observeReactionSession } from '../../threads/thread-reactions';
import { browserObservation } from '../../session';

/** Observe the existing owners without starting a session, exposure or per-card request. */
function observeCommunityEnvironment(client: QueryClient | undefined) {
  const session = observeReactionSession(client);
  let exposureRevision = 0;
  const exposure = () => {
    const state = client?.getQueryState(['exposure', 'viewer']);
    return JSON.stringify([state?.status, state?.dataUpdateCount, state?.errorUpdateCount]);
  };
  let previous = exposure();
  const snapshot = () => {
    const next = exposure();
    if (next !== previous) {
      previous = next;
      exposureRevision++;
    }
    return `${session.snapshot()}:${exposureRevision}`;
  };
  return {
    session,
    snapshot,
    serverSnapshot: () => '0:0',
    subscribe(notify: () => void) {
      let active = true;
      const observation = client && browserObservation(client);
      const publish = () => {
        if (active) notify();
      };
      const stopSession = session.subscribe(notify);
      const stopExposure = observation?.subscribeCache((event) => {
        if (
          event.query.queryKey.length !== 2 ||
          event.query.queryKey[0] !== 'exposure' ||
          event.query.queryKey[1] !== 'viewer'
        )
          return;
        if (
          event.type !== 'added' &&
          event.type !== 'removed' &&
          !(event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
        )
          return;
        previous = exposure();
        exposureRevision++;
        observation.publish(publish);
      });
      return () => {
        active = false;
        stopSession();
        stopExposure?.();
      };
    },
  };
}

/** A retained native observation cannot be rebound to replacement browser credentials or disclosure. */
export function useSubjectCommunityReading(input: {
  source: object | string;
  descriptor: string;
  reader: string | null;
}) {
  const client = useContext(QueryClientContext);
  const environment = useMemo(() => observeCommunityEnvironment(client), [client]);
  const revision = useSyncExternalStore(environment.subscribe, environment.snapshot, environment.serverSnapshot);
  const session = environment.session.read();
  const readerReady =
    !client ||
    input.reader === null ||
    (environment.session.healthy() &&
      session?.state === 'signed-in' &&
      session.subject === input.reader &&
      Boolean(session.csrfToken));
  const [binding, setBinding] = useState({ ...input, environment, revision, retired: !readerReady, generation: 0 });
  if (binding.source !== input.source) {
    setBinding({ ...input, environment, revision, retired: !readerReady, generation: binding.generation + 1 });
  } else if (
    !binding.retired &&
    (!readerReady ||
      binding.reader !== input.reader ||
      binding.descriptor !== input.descriptor ||
      binding.environment !== environment ||
      binding.revision !== revision)
  ) {
    setBinding({ ...binding, retired: true, generation: binding.generation + 1 });
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
  return {
    available: !binding.retired,
    key: String(binding.generation),
    isCurrent: () =>
      mounted.current && current.current === binding && !binding.retired && environment.snapshot() === binding.revision,
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
    isCurrent: () => input.ready && visit.current === owned && owned.active,
  };
}
