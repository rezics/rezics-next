import type { QueryClient } from '@tanstack/react-query';
import type { ReporterStatus } from './reporter-status-model';

/** Session identity is compared in memory only; it is never a credential or command grant. */
export type ReporterStatusViewer = { subject: string; csrfToken: string };
export type ReporterStatusResult =
  | { state: 'loaded'; report: ReporterStatus }
  | { state: 'loading' | 'unavailable' | 'concealed' | 'closed' };
export type ReporterStatusRead = {
  id: string;
  generation: string;
  viewer: ReporterStatusViewer | null;
  result: { state: 'loaded'; report: ReporterStatus } | { state: 'unavailable' | 'concealed' | 'closed' };
};
export type ReporterStatusReader = (input: { id: string; generation: string }) => Promise<ReporterStatusRead>;
export type ReporterStatusNavigation = { isCurrent: () => boolean; subscribe: (retire: () => void) => () => void };
type BrowserSession = { state: string; subject?: string | null; csrfToken: string | null };
const concealed = { state: 'concealed' } as const;
const retired = new WeakSet<ReporterStatusRead>();
const handovers = new WeakMap<ReporterStatusRead, () => void>();

export function reporterStatusViewer(session: BrowserSession | undefined): ReporterStatusViewer | null {
  return session?.state === 'signed-in' && session.subject && session.csrfToken
    ? { subject: session.subject, csrfToken: session.csrfToken }
    : null;
}
function currentViewer(cache: QueryClient) {
  return reporterStatusViewer(cache.getQueryData<BrowserSession>(['session']));
}
function sameViewer(a: ReporterStatusViewer | null, b: ReporterStatusViewer | null) {
  return !!a && !!b && a.subject === b.subject && a.csrfToken === b.csrfToken;
}

/** Observe the whole pending route read, including an away-and-back session replacement. */
export async function prepareReporterStatusRead(
  cache: QueryClient,
  id: string,
  read: ReporterStatusReader,
  signal?: AbortSignal,
) {
  const viewer = currentViewer(cache);
  const generation = crypto.randomUUID();
  let active = !!viewer && !signal?.aborted;
  if (!active) return { id, generation, viewer: null, result: concealed } satisfies ReporterStatusRead;
  let settled: ReporterStatusRead | undefined;
  let handingOver = false;
  const release = () => {
    signal?.removeEventListener('abort', abort);
    unsubscribe();
    if (settled) handovers.delete(settled);
  };
  const abort = () => {
    active = false;
    if (settled) {
      retired.add(settled);
      settled.result = concealed;
      settled.viewer = null;
      release();
    }
  };
  const unsubscribe = cache.getQueryCache().subscribe(() => {
    if (!sameViewer(viewer, currentViewer(cache))) abort();
  });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await read({ id, generation });
    // A preparation outage has no private payload. Bind only its recovery UI to this browser attempt.
    const result = !response.viewer && response.result.state === 'unavailable' ? { ...response, viewer } : response;
    if (!active || result.id !== id || result.generation !== generation || !sameViewer(viewer, result.viewer)) {
      retired.add(result);
      return { id, generation, viewer: null, result: concealed } satisfies ReporterStatusRead;
    }
    settled = result;
    // Keep observing between client loader settlement and the mounted subscriber's handover.
    if (typeof window !== 'undefined') {
      handingOver = true;
      handovers.set(result, release);
    }
    return result;
  } catch {
    return {
      id,
      generation,
      viewer: active ? viewer : null,
      result: active ? { state: 'unavailable' as const } : concealed,
    };
  } finally {
    if (!handingOver) release();
  }
}

/** One mounted private journey. Retirement erases displayed bytes and invalidates every pending settlement. */
export function createReporterStatusJourney(
  cache: QueryClient,
  initial: ReporterStatusRead,
  read: ReporterStatusReader,
  navigation?: ReporterStatusNavigation,
) {
  let result: ReporterStatusResult = retired.has(initial) ? concealed : initial.result;
  let viewer = initial.viewer;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: ReporterStatusResult) => {
    result = next;
    for (const listener of listeners) listener();
  };
  const retire = () => {
    retired.add(initial);
    initial.result = concealed;
    initial.viewer = null;
    generation++;
    viewer = null;
    if (result !== concealed) publish(concealed);
  };
  const observe = () => {
    if (!sameViewer(viewer, currentViewer(cache)) || navigation?.isCurrent() === false) retire();
  };
  const snapshot = () => {
    observe();
    return result;
  };
  return {
    snapshot,
    // SSR uses only the prepared response; browser unknown state never admits private bytes.
    serverSnapshot: () => (initial.viewer && !retired.has(initial) ? initial.result : concealed),
    subscribe(listener: () => void) {
      listeners.add(listener);
      const unsubscribe = cache.getQueryCache().subscribe(observe);
      const unsubscribeNavigation = navigation?.subscribe(retire);
      handovers.get(initial)?.();
      observe();
      return () => {
        unsubscribe();
        unsubscribeNavigation?.();
        listeners.delete(listener);
        retired.add(initial);
        // React may replay a subscription synchronously. A real unmount still closes settlement immediately.
        queueMicrotask(() => {
          if (!listeners.size) {
            disposed = true;
            retire();
          }
        });
      };
    },
    isCurrent: () =>
      !disposed && listeners.size > 0 && sameViewer(viewer, currentViewer(cache)) && navigation?.isCurrent() !== false,
    async retry() {
      observe();
      if (disposed || !listeners.size || result.state !== 'unavailable') return;
      const expected = currentViewer(cache);
      if (!expected) return retire();
      viewer = expected;
      const attempt = ++generation;
      const requestGeneration = crypto.randomUUID();
      publish({ state: 'loading' });
      try {
        const next = await read({ id: initial.id, generation: requestGeneration });
        if (disposed || !listeners.size || attempt !== generation) return;
        observe();
        if (attempt !== generation) return;
        if (
          next.id !== initial.id ||
          next.generation !== requestGeneration ||
          (!sameViewer(expected, next.viewer) && !(next.viewer === null && next.result.state === 'unavailable'))
        ) {
          retire();
          return;
        }
        publish(next.result);
      } catch {
        if (!disposed && listeners.size && attempt === generation && sameViewer(expected, currentViewer(cache)))
          publish({ state: 'unavailable' });
      }
    },
  };
}
