import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { operationIsAdmitted } from '../kernel/exposure';
import {
  viewerExposureLifetime,
  viewerExposureQuery,
  type ViewerExposure,
  type ViewerObservation,
} from '../kernel/viewer-exposure';
import { sessionQuery, useSession } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';

type Session = { state?: string; subject?: string | null; csrfToken?: string | null };
type Identity = { subject: string | null; generation: number; lifetime: string; active: boolean };
type Snapshot = {
  identity: Identity;
  observation: ViewerObservation | undefined;
  csrfToken: string;
  admitted: boolean;
  canLabel: boolean;
};
let nextGeneration = 0;
const identity = (subject: string | null): Identity => ({
  subject,
  generation: ++nextGeneration,
  lifetime: crypto.randomUUID(),
  active: true,
});
const serverSnapshot: Snapshot = {
  identity: { subject: null, generation: 0, lifetime: '', active: false },
  observation: undefined,
  csrfToken: '',
  admitted: false,
  canLabel: false,
};

/** Owning composition only: the shared lifetime supplies the actual enrolled exposure observation. */
function ownerStore(client: QueryClient) {
  const exposure = viewerExposureLifetime(client);
  let snapshot = { ...serverSnapshot, identity: identity(null) };
  let signature: readonly unknown[] = [];
  let mounted = false;
  let retired = false;
  const listeners = new Set<() => void>();

  function read() {
    if (retired) return snapshot;
    const session = client.getQueryState<Session>(sessionQuery.queryKey);
    const actual = session?.status === 'success' ? session.data : undefined;
    // A failed/removed authority read suspends work without discarding an uncertain command.
    // Only an observed successful identity change or sign-out replaces its owning intent.
    const subject = actual
      ? actual.state === 'signed-in' && typeof actual.subject === 'string' && actual.subject
        ? actual.subject
        : null
      : snapshot.identity.subject;
    if (subject !== snapshot.identity.subject || !snapshot.identity.active) {
      snapshot.identity.active = false;
      snapshot = { ...snapshot, identity: identity(subject), csrfToken: '' };
    }
    const csrf =
      actual?.state === 'signed-in' &&
      actual.subject === subject &&
      typeof actual.csrfToken === 'string' &&
      actual.csrfToken.trim().length > 0
        ? actual.csrfToken
        : null;
    const enrolled = exposure.getSnapshot();
    const observation =
      mounted &&
      actual?.state === 'signed-in' &&
      enrolled.state === 'signed-in' &&
      enrolled.observation.subject === subject
        ? enrolled.observation
        : undefined;
    const key = viewerExposureQuery(observation).queryKey;
    const query = client.getQueryCache().find({ queryKey: key, exact: true });
    const state = query?.state;
    const response = state?.status === 'success' ? (state.data as ViewerExposure | undefined) : undefined;
    const groups =
      observation && response?.subject === observation.subject && Array.isArray(response.admitted)
        ? response.admitted
        : undefined;
    const next = [
      mounted,
      snapshot.identity,
      session?.status,
      csrf,
      observation,
      query,
      state?.status,
      state?.data,
      state?.dataUpdatedAt,
    ];
    if (next.length !== signature.length || next.some((value, index) => value !== signature[index])) {
      signature = next;
      snapshot = {
        identity: snapshot.identity,
        observation,
        csrfToken: csrf ?? '',
        admitted: !!subject && operationIsAdmitted('collection.get', groups),
        canLabel: !!subject && operationIsAdmitted('library_label.list', groups),
      };
    }
    return snapshot;
  }
  function changed() {
    const previous = snapshot;
    read();
    if (snapshot !== previous) listeners.forEach((notify) => notify());
  }
  return {
    read,
    retire() {
      retired = true;
      snapshot.identity.active = false;
    },
    subscribe(notify: () => void) {
      listeners.add(notify);
      mounted = true;
      // Subscribe to the lifetime first: cache listeners then see its replacement observation,
      // even during a synchronous A-to-B-to-A before React has committed anything.
      const stopLifetime = exposure.subscribe(changed);
      const stopCache = client.getQueryCache().subscribe(changed);
      changed();
      return () => {
        listeners.delete(notify);
        stopCache();
        stopLifetime();
        if (!listeners.size) {
          mounted = false;
          snapshot.identity.active = false;
        }
      };
    },
    current(origin: Snapshot) {
      return !retired && mounted && read() === origin && origin.identity.active && origin.admitted;
    },
    owns(origin: Snapshot) {
      return !retired && mounted && read().identity === origin.identity && origin.identity.active;
    },
  };
}

/** Authority episodes retire permanently; intent identity survives healthy refresh/admission churn. */
export function useCollectionOwnerCurrent(address: string, _withLabels = false) {
  useSession();
  const client = useQueryClient();
  const locale = getLocale();
  const store = useMemo(() => ownerStore(client), [client, address, locale]);
  const previous = useRef(store);
  if (previous.current !== store) {
    previous.current.retire();
    previous.current = store;
  }
  const snapshot = useSyncExternalStore(store.subscribe, store.read, () => serverSnapshot);
  useQuery(viewerExposureQuery(snapshot.observation));
  const isCurrent = () => store.current(snapshot) && getLocale() === locale;
  return {
    subject: snapshot.identity.subject,
    admitted: snapshot.admitted,
    canLabel: snapshot.canLabel,
    isCurrent,
    isOwnerCurrent: () => store.owns(snapshot) && getLocale() === locale,
    canLabelCurrent: () => isCurrent() && snapshot.canLabel,
    credential: () => (isCurrent() ? snapshot.csrfToken || null : null),
    csrfToken: snapshot.csrfToken,
    generation: snapshot.identity.generation,
    lifetime: snapshot.identity.lifetime,
  };
}
