import type { QueryClient } from '@tanstack/react-query';
import type { ReporterStatus } from './reporter-status-model';
import type { PrivateReaderOrigin } from './private-reader-origin';
import {
  createPrivateReaderLifetime,
  preparePrivateReaderRead,
  type PrivateReaderRead,
  type PrivateReaderNavigation,
} from './private-reader-lifetime';

export type ReporterStatusViewer = PrivateReaderOrigin;
export type ReporterStatusResult =
  | { state: 'loaded'; report: ReporterStatus }
  | { state: 'loading' | 'unavailable' | 'concealed' | 'closed' };
export type ReporterStatusRead = PrivateReaderRead & {
  id: string;
  generation: string;
  viewer: ReporterStatusViewer | null;
  result: { state: 'loaded'; report: ReporterStatus } | { state: 'unavailable' | 'concealed' | 'closed' };
};
export type ReporterStatusReader = (input: { id: string; generation: string }) => Promise<ReporterStatusRead>;
export type ReporterStatusNavigation = PrivateReaderNavigation;
const concealed = { state: 'concealed' } as const;
const unavailable = { state: 'unavailable' } as const;
export const reporterStatusReadKey = (id: string) => JSON.stringify(['reporter-status', id]);

/** The original browser observation precedes actual BFF preparation and survives the loader-to-mount gap. */
export async function prepareReporterStatusRead(
  cache: QueryClient,
  id: string,
  read: ReporterStatusReader,
  signal?: AbortSignal,
): Promise<ReporterStatusRead> {
  const generation = crypto.randomUUID();
  const response = await preparePrivateReaderRead(
    cache,
    reporterStatusReadKey(id),
    async () => {
      try {
        const response = await read({ id, generation });
        if (response.id !== id || response.generation !== generation)
          return { id, generation, viewer: null, readerOrigin: null, result: concealed };
        return response;
      } catch {
        return { id, generation, viewer: null, readerOrigin: null, result: unavailable };
      }
    },
    signal,
  );
  return response.readerBinding.retired
    ? { ...response, viewer: null, result: concealed }
    : !response.readerOrigin && response.result.state === 'loaded'
      ? { ...response, viewer: null, result: unavailable }
      : response;
}

/** One mounted journey; no page mutation, successor cleanup, expected-viewer stamping or automatic read. */
export function createReporterStatusJourney(
  cache: QueryClient,
  initial: ReporterStatusRead,
  read: ReporterStatusReader,
  navigation?: ReporterStatusNavigation,
) {
  const owner = createPrivateReaderLifetime(cache, initial, reporterStatusReadKey(initial.id), navigation);
  let result: ReporterStatusResult = initial.result;
  let resultOrigin = initial.readerOrigin;
  let generation = 0;
  let busy = false;
  const listeners = new Set<() => void>();
  const publish = (next: ReporterStatusResult) => {
    result = next;
    for (const listener of listeners) listener();
  };
  const own = (next: ReporterStatusRead) =>
    next.result.state !== 'loaded' ||
    (next.result.report.id === initial.id && next.result.report.reporterId === next.readerOrigin?.subject);
  const snapshot = (): ReporterStatusResult => {
    if (!owner.healthy()) return concealed;
    if (result.state === 'loaded' && !owner.available()) return unavailable;
    if (
      result.state === 'loaded' &&
      (result.report.id !== initial.id || result.report.reporterId !== resultOrigin?.subject)
    )
      return concealed;
    return result;
  };
  if (initial.readerOrigin && !own(initial)) owner.retire();
  return {
    retire: owner.retire,
    snapshot,
    // Existing prepared SSR presentation is retained; this is not a private first-paint proof.
    serverSnapshot: () => (initial.viewer && own(initial) ? initial.result : concealed),
    subscribe(listener: () => void) {
      listeners.add(listener);
      const stop = owner.subscribe(() => {
        for (const listener of listeners) listener();
      });
      return () => {
        listeners.delete(listener);
        generation++;
        stop();
      };
    },
    isConnected: owner.isCurrent,
    isCurrent: () => owner.isCurrent() && owner.available() && snapshot().state === 'loaded',
    async retry() {
      if (!owner.isCurrent() || busy || snapshot().state !== 'unavailable') return;
      busy = true;
      const attempt = ++generation;
      const ticket = owner.ticket();
      const requestGeneration = crypto.randomUUID();
      publish({ state: 'loading' });
      try {
        const next = await read({ id: initial.id, generation: requestGeneration });
        if (!owner.owns(ticket) || attempt !== generation) return;
        if (next.id !== initial.id || next.generation !== requestGeneration || !own(next)) return owner.retire();
        if (!next.readerOrigin && next.result.state === 'unavailable') publish(unavailable);
        else if (await owner.accepts(next)) {
          if (owner.owns(ticket) && attempt === generation) {
            resultOrigin = next.readerOrigin;
            publish(next.result);
          }
        } else owner.retire();
      } catch {
        if (owner.owns(ticket) && attempt === generation) publish(unavailable);
      } finally {
        if (owner.owns(ticket) && attempt === generation) busy = false;
      }
    },
  };
}
