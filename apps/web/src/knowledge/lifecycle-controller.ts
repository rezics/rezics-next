import { useEffect, useRef, useState } from 'react';
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
  const [observation, setObservation] = useState<Observation | null>(null);
  const [readState, setReadState] = useState('preparing');
  const [commandState, setCommandState] = useState('idle');
  const [intent, setIntent] = useState<KnowledgeLifecycleIntent | null>(null);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const reading = useRef(false);
  const retireRef = useRef(onRetire);
  retireRef.current = onRetire;
  const enabled = !!address && !!operations;

  function retire(state: 'denied' | 'signed-out' | 'retired') {
    sequence.current++;
    setObservation(null);
    setIntent(null);
    setReadState(state);
    setCommandState('idle');
    retireRef.current(state);
  }

  async function reread() {
    if (!address || !operations || admission !== 'available' || reading.current || !mounted.current) return;
    const attempt = ++sequence.current;
    reading.current = true;
    setReadState('preparing');
    try {
      const result = await operations.read(address, expected);
      if (!mounted.current || sequence.current !== attempt) return;
      if (result.state === 'ready') {
        if (result.binding.viewer !== expected.viewer || result.binding.csrfToken !== expected.csrfToken) {
          retire('retired');
          return;
        }
        setObservation(result);
        setReadState('ready');
        setRevision((current) => current + 1);
      } else if (result.state === 'denied' || result.state === 'retired' || result.state === 'signed-out') {
        retire(result.state);
      } else {
        setObservation(null);
        setReadState(result.state);
      }
    } catch {
      if (mounted.current && sequence.current === attempt) {
        setObservation(null);
        setReadState('unavailable');
      }
    } finally {
      reading.current = false;
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (enabled) {
      if (admission === 'available') void reread();
      else setReadState(admission === 'unknown' ? 'preparing' : admission);
    }
    return () => {
      mounted.current = false;
      sequence.current++;
      reading.current = false;
    };
  }, [address?.notebookId, address?.documentId, expected.viewer, expected.csrfToken, operations, admission]);

  const lifecycle = observation?.lifecycle ?? null;
  const allowed = (action: 'trash' | 'restore') =>
    (action === 'trash' ? trashAdmission : restoreAdmission) === 'available';

  function review(blocked: boolean) {
    if (blocked || !observation || readState !== 'ready' || intent || inFlight.current) return;
    const action = observation.lifecycle.state === 'active' ? 'trash' : 'restore';
    if (!allowed(action)) return;
    if (action === 'restore' && knowledgeRestoreExpired(observation.lifecycle)) {
      setCommandState('expired');
      return;
    }
    setIntent(reviewKnowledgeLifecycle(observation.lifecycle, observation.binding, action));
    setCommandState('confirm');
  }

  async function submit(blocked: boolean) {
    if (blocked || !intent || !operations || !allowed(intent.action) || inFlight.current || !mounted.current) return;
    if (commandState === 'confirm' && intent.action === 'restore' && lifecycle && knowledgeRestoreExpired(lifecycle)) {
      setIntent(null);
      setCommandState('expired');
      return;
    }
    const attempt = sequence.current;
    inFlight.current = true;
    setCommandState('pending');
    try {
      const result = await operations.change(intent);
      if (!mounted.current || sequence.current !== attempt) return;
      if (result.state === 'denied' || result.state === 'retired' || result.state === 'signed-out') {
        retire(result.state);
      } else if (result.state === 'acknowledged') {
        setIntent(null);
        setCommandState(result.receipt.complete ? 'acknowledged' : 'subtree');
        await reread();
      } else if (result.state === 'conflict' || result.state === 'not-found') {
        setIntent(null);
        setCommandState(result.state);
        await reread();
      } else {
        // Transport failure does not establish whether the command took effect.
        setCommandState(result.state);
      }
    } catch {
      if (mounted.current && sequence.current === attempt) setCommandState('uncertain');
    } finally {
      inFlight.current = false;
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
    locked: !!intent || (enabled && readState !== 'ready'),
    editing: !enabled || (readState === 'ready' && lifecycle?.state === 'active'),
    actionAdmission: lifecycle?.state === 'trashed' ? restoreAdmission : trashAdmission,
    review,
    submit,
    reread,
    cancel() {
      if (commandState !== 'confirm') return;
      setIntent(null);
      setCommandState('idle');
    },
  };
}

export type KnowledgeLifecycleController = ReturnType<typeof useKnowledgeLifecycle>;
