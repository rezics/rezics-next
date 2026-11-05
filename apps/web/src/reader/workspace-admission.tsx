import { QueryClientContext, useQuery, QueryClient } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { operationIsAdmitted } from '../kernel/exposure';
import { viewerExposureLifetime, viewerExposureQuery, type ViewerObservation } from '../kernel/viewer-exposure';
import { sessionQuery } from '../session/query';
import { browserObservation } from '../session/observation';

type Operation = Parameters<typeof operationIsAdmitted>[0];
type Snapshot = {
  subject: string | null;
  viewer: number;
  observation: ViewerObservation | undefined;
  allowed: boolean[];
  /** Last successful decision is retained only as draft custody, never dispatch authority. */
  granted: boolean[];
  episodes: number[];
  dispatch: number[];
  rejected: boolean;
};

/** Operation admission and retained intent are separate from session identity and credentials. */
export function workspaceAdmission(client: QueryClient | undefined, operations: readonly Operation[]) {
  const lifetime = client && viewerExposureLifetime(client);
  const server: Snapshot = {
    subject: null,
    viewer: 0,
    observation: undefined,
    allowed: operations.map(() => false),
    granted: operations.map(() => false),
    episodes: operations.map(() => 0),
    dispatch: operations.map(() => 0),
    rejected: false,
  };
  let snapshot = server;
  let seen = false;
  let decided = false;
  let exposureObject: unknown;
  const listeners = new Set<() => void>();
  const read = (): Snapshot => {
    const session = client?.getQueryState(sessionQuery.queryKey);
    const viewer = session?.status === 'success' ? session.data : undefined;
    const subject = viewer?.state === 'signed-in' && viewer.subject ? viewer.subject : null;
    const enrolled = lifetime?.getSnapshot();
    const observation =
      subject && enrolled?.state === 'signed-in' && enrolled.observation.subject === subject
        ? enrolled.observation
        : undefined;
    const key = viewerExposureQuery(observation).queryKey;
    const query = observation ? client?.getQueryCache().find({ queryKey: key, exact: true }) : undefined;
    const state = observation ? client?.getQueryState(viewerExposureQuery(observation).queryKey) : undefined;
    const data = state?.status === 'success' ? state.data : undefined;
    const valid = !!subject && !!observation && data?.subject === observation.subject;
    const rejected = !!observation && !!state && state.status !== 'pending' && !valid;
    const allowed = operations.map((operation) => valid && operationIsAdmitted(operation, data?.admitted));
    const sameViewer = subject === snapshot.subject;
    const changedObservation = observation !== snapshot.observation;
    // A new observation is closed until its actual response arrives. Healthy credential rotation
    // does not destroy the native intent; errors/replacements of an enrolled read still retire callbacks.
    const preparing = sameViewer && changedObservation && (!state || state.status === 'pending');
    const granted = valid ? allowed : sameViewer ? snapshot.granted : operations.map(() => false);
    const episodes = operations.map(
      (_, i) =>
        snapshot.episodes[i]! +
        Number(
          seen &&
            !preparing &&
            (!sameViewer ||
              (decided && valid && allowed[i] !== snapshot.granted[i]) ||
              (snapshot.granted[i] && rejected && !snapshot.rejected) ||
              (!changedObservation && snapshot.allowed[i] && (!allowed[i] || query !== exposureObject))),
        ),
    );
    const dispatch = operations.map(
      (_, i) =>
        snapshot.dispatch[i]! +
        Number(
          seen &&
            (!sameViewer ||
              changedObservation ||
              allowed[i] !== snapshot.allowed[i] ||
              (snapshot.allowed[i] && query !== exposureObject)),
        ),
    );
    if (
      !seen ||
      !sameViewer ||
      changedObservation ||
      rejected !== snapshot.rejected ||
      allowed.some((value, i) => value !== snapshot.allowed[i]) ||
      episodes.some((value, i) => value !== snapshot.episodes[i]) ||
      dispatch.some((value, i) => value !== snapshot.dispatch[i])
    ) {
      snapshot = {
        subject,
        viewer: snapshot.viewer + Number(seen && !sameViewer),
        observation,
        allowed,
        granted,
        episodes,
        dispatch,
        rejected,
      };
    }
    if (!sameViewer) decided = false;
    if (valid) decided = true;
    seen = true;
    exposureObject = query;
    return snapshot;
  };
  const publish = () => listeners.forEach((notify) => notify());
  const changed = () => {
    const before = snapshot;
    read();
    if (before !== snapshot) lifetime?.publish(publish);
  };
  return {
    read,
    server: () => server,
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      const stopLifetime = lifetime?.subscribe(changed);
      const stopCache = client && browserObservation(client).subscribeCache(changed);
      changed();
      return () => {
        listeners.delete(notify);
        stopCache?.();
        stopLifetime?.();
      };
    },
    watch: (notify: () => void) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    allowed: (operation: Operation) => read().allowed[operations.indexOf(operation)] === true,
    dispatchVersion: (operation: Operation) => read().dispatch[operations.indexOf(operation)],
    version: (operation: Operation) => read().episodes[operations.indexOf(operation)],
    headers: (subject: string | null) => {
      const current = read();
      const session = client?.getQueryState(sessionQuery.queryKey);
      return subject && current.subject === subject && session?.status === 'success' && session.data?.csrfToken
        ? { 'x-csrf-token': session.data.csrfToken }
        : null;
    },
  };
}
export type WorkspaceAdmission = ReturnType<typeof workspaceAdmission>;

const previewClient = new QueryClient();

export function useWorkspaceAdmission(operations: readonly Operation[]) {
  const client = useContext(QueryClientContext);
  const store = useMemo(() => workspaceAdmission(client, operations), [client, operations]);
  const value = useSyncExternalStore(store.subscribe, store.read, store.server);
  useQuery(
    { ...viewerExposureQuery(value.observation), enabled: value.observation !== undefined },
    client ?? previewClient,
  );
  return { store, value };
}
