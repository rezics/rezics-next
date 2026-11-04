import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { browserObservation } from '../../../../session/observation';
import { addressLease } from '../../../../reader/lease';

/** Domain identity stays in this mount; the installed browser store owns cache observation. */
export function useArcLifetime(input: { source: object | string; descriptor: string; reader: string | null }) {
  const client = useContext(QueryClientContext);
  const observation = useMemo(() => {
    const store = client ? browserObservation(client) : undefined;
    let revision = 0;
    let previous = '';
    const snapshot = () => {
      const session = client?.getQueryState(['session']);
      const exposure = client?.getQueryState(['exposure', 'viewer']);
      const next = JSON.stringify([
        session?.status,
        session?.fetchStatus,
        session?.isInvalidated,
        session?.dataUpdateCount,
        session?.errorUpdateCount,
        exposure?.status,
        exposure?.dataUpdateCount,
        exposure?.errorUpdateCount,
        store?.getSnapshot(),
      ]);
      if (next !== previous) {
        previous = next;
        revision++;
      }
      return revision;
    };
    return { store, snapshot, subscribe: store?.subscribeCache ?? (() => () => {}), server: () => 0 };
  }, [client]);
  const revision = useSyncExternalStore(observation.subscribe, observation.snapshot, observation.server);
  const mounted = useRef(false);
  const [, redraw] = useState(0);
  const makeBinding = (generation: number) => {
    const state = observation.store?.getSnapshot();
    const admitted =
      input.reader === null || (state?.state === 'signed-in' && state.observation.subject === input.reader);
    const lease = addressLease(() => mounted.current && admitted && observation.snapshot() === revision);
    const ready = !observation.store || state?.state === 'signed-in' || state?.state === 'signed-out';
    return { ...input, observation, revision, lease, generation, ready, retired: ready && !admitted };
  };
  const [binding, setBinding] = useState(() => makeBinding(0));
  if (binding.source !== input.source) {
    binding.lease.retire();
    setBinding(makeBinding(binding.generation + 1));
  } else if (!binding.ready && binding.revision !== revision) {
    binding.lease.retire();
    setBinding(makeBinding(binding.generation));
  } else if (
    !binding.retired &&
    (binding.descriptor !== input.descriptor ||
      binding.reader !== input.reader ||
      binding.observation !== observation ||
      binding.revision !== revision)
  ) {
    binding.lease.retire();
    setBinding({ ...binding, retired: true, generation: binding.generation + 1 });
  }
  useLayoutEffect(() => {
    mounted.current = true;
    const depart = () => {
      binding.lease.retire();
      redraw((value) => value + 1);
    };
    window.addEventListener('pagehide', depart);
    window.addEventListener('popstate', depart);
    return () => {
      mounted.current = false;
      binding.lease.retire();
      window.removeEventListener('pagehide', depart);
      window.removeEventListener('popstate', depart);
    };
  }, [binding.lease]);
  // Do not probe a lease during render before the mount's layout effect admits it.
  return {
    available: binding.ready && !binding.retired && (!mounted.current || binding.lease.current()),
    key: String(binding.generation),
    current: binding.lease.current,
  };
}
