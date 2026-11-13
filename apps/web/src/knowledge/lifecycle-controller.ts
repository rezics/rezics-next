import { useEffect, useMemo, useRef, useState } from 'react';
import type { KnowledgePrivateAddress } from './private-knowledge';
import {
  knowledgeRestoreExpired,
  reviewKnowledgeLifecycle,
  type KnowledgeLifecycleBinding,
  type KnowledgeLifecycleIntent,
  type KnowledgeLifecycleOperations,
  type KnowledgeLifecycleRead,
} from './lifecycle';

type Admission = 'unknown' | 'available' | 'denied' | 'unavailable';
type Observation = Extract<KnowledgeLifecycleRead, { state: 'ready' }>;
type Visit = {
  identity: object;
  active: boolean;
  reading: boolean;
  inFlight: boolean;
};
type State = {
  visit: Visit | null;
  observation: Observation | null;
  readState: string;
  commandState: string;
  intent: KnowledgeLifecycleIntent | null;
  revision: number;
};
const initial: State = {
  visit: null,
  observation: null,
  readState: 'preparing',
  commandState: 'idle',
  intent: null,
  revision: 0,
};

/** One private visit owns metadata, review and exact retries; none enter a shared cache. */
export function useKnowledgeLifecycle({
  address,
  expected,
  operations,
  admission,
  trashAdmission,
  restoreAdmission,
  onRetire,
}: {
  address: KnowledgePrivateAddress | null;
  expected: Pick<KnowledgeLifecycleBinding, 'viewer' | 'csrfToken'>;
  operations: KnowledgeLifecycleOperations | undefined;
  admission: Admission;
  trashAdmission: Admission;
  restoreAdmission: Admission;
  onRetire: (state: 'denied' | 'signed-out' | 'retired') => void;
}) {
  const [state, setState] = useState(initial);
  const current = useRef<Visit | null>(null);
  const retireRef = useRef(onRetire);
  retireRef.current = onRetire;
  const enabled = !!address && !!operations;
  const identity = useMemo(
    () => ({}),
    [address?.notebookId, address?.documentId, expected.viewer, expected.csrfToken, operations, admission],
  );
  // Hide former metadata and reviews during the replacement render, before effect cleanup.
  const snapshot = state.visit?.identity === identity && state.visit === current.current ? state : initial;

  function isCurrent(visit: Visit) {
    return visit.active && current.current === visit;
  }

  function update(visit: Visit, change: Partial<State>) {
    if (!isCurrent(visit)) return;
    setState((previous) => (previous.visit === visit ? { ...previous, ...change } : previous));
  }

  function retire(visit: Visit, readState: 'denied' | 'signed-out' | 'retired') {
    if (!isCurrent(visit)) return;
    update(visit, { observation: null, intent: null, readState, commandState: 'idle' });
    visit.active = false;
    retireRef.current(readState);
  }

  async function reread(visit: Visit) {
    if (!address || !operations || admission !== 'available' || visit.reading || !isCurrent(visit)) return;
    visit.reading = true;
    update(visit, { readState: 'preparing' });
    try {
      const result = await operations.read(address, expected);
      if (!isCurrent(visit)) return;
      if (result.state === 'ready') {
        if (result.binding.viewer !== expected.viewer || result.binding.csrfToken !== expected.csrfToken) {
          retire(visit, 'retired');
          return;
        }
        setState((previous) =>
          previous.visit === visit
            ? { ...previous, observation: result, readState: 'ready', revision: previous.revision + 1 }
            : previous,
        );
      } else if (result.state === 'denied' || result.state === 'retired' || result.state === 'signed-out') {
        retire(visit, result.state);
      } else {
        update(visit, { observation: null, readState: result.state });
      }
    } catch {
      update(visit, { observation: null, readState: 'unavailable' });
    } finally {
      // This flag belongs to this effect generation, including Strict Mode replacements.
      visit.reading = false;
    }
  }

  useEffect(() => {
    const visit: Visit = { identity, active: true, reading: false, inFlight: false };
    current.current = visit;
    setState({ ...initial, visit });
    if (enabled) {
      if (admission === 'available') void reread(visit);
      else update(visit, { readState: admission === 'unknown' ? 'preparing' : admission });
    }
    return () => {
      visit.active = false;
      if (current.current === visit) current.current = null;
    };
  }, [identity]);

  const { observation, readState, commandState, intent, revision } = snapshot;
  const lifecycle = observation?.lifecycle ?? null;
  const allowed = (action: 'trash' | 'restore') =>
    (action === 'trash' ? trashAdmission : restoreAdmission) === 'available';

  function review(blocked: boolean) {
    const visit = snapshot.visit;
    if (blocked || !visit || !isCurrent(visit) || !observation || readState !== 'ready' || intent || visit.inFlight)
      return;
    if (observation.lifecycle.restoreProgress) return;
    const action = observation.lifecycle.state === 'active' ? 'trash' : 'restore';
    if (!allowed(action)) return;
    if (action === 'restore' && knowledgeRestoreExpired(observation.lifecycle)) {
      update(visit, { commandState: 'expired' });
      return;
    }
    update(visit, {
      intent: reviewKnowledgeLifecycle(observation.lifecycle, observation.binding, action),
      commandState: 'confirm',
    });
  }

  async function submit(blocked: boolean) {
    const visit = snapshot.visit;
    if (blocked || !visit || !isCurrent(visit) || !intent || !operations || !allowed(intent.action) || visit.inFlight)
      return;
    if (commandState === 'confirm' && intent.action === 'restore' && lifecycle && knowledgeRestoreExpired(lifecycle)) {
      update(visit, { intent: null, commandState: 'expired' });
      return;
    }
    visit.inFlight = true;
    update(visit, { commandState: 'pending' });
    try {
      const result = await operations.change(intent);
      if (!isCurrent(visit)) return;
      if (result.state === 'denied' || result.state === 'retired' || result.state === 'signed-out') {
        retire(visit, result.state);
      } else if (result.state === 'acknowledged' || result.state === 'conflict' || result.state === 'not-found') {
        update(visit, { intent: null, commandState: result.state });
        await reread(visit);
      } else {
        // Transport failure does not establish whether the command took effect.
        update(visit, { commandState: result.state });
      }
    } catch {
      update(visit, { commandState: 'uncertain' });
    } finally {
      visit.inFlight = false;
    }
  }

  const unresolved = !!intent && commandState !== 'confirm';
  return {
    enabled,
    lifecycle,
    readState,
    commandState,
    revision,
    intent,
    pending: commandState === 'pending',
    unresolved,
    locked: !!intent || (enabled && (readState !== 'ready' || lifecycle?.state !== 'active')),
    editing: !enabled || (readState === 'ready' && lifecycle?.state === 'active'),
    actionAdmission: lifecycle?.state === 'trashed' ? restoreAdmission : trashAdmission,
    review,
    submit,
    async reread() {
      const visit = snapshot.visit;
      if (!visit || intent || visit.inFlight) return;
      await reread(visit);
    },
    cancel() {
      const visit = snapshot.visit;
      if (!visit || commandState !== 'confirm') return;
      update(visit, { intent: null, commandState: 'idle' });
    },
  };
}

export type KnowledgeLifecycleController = ReturnType<typeof useKnowledgeLifecycle>;
