import type { ShelfSummaryCurrentRead, ShelfSummaryView } from './shelf-summary-read';

export type ShelfSummaryState = ShelfSummaryView | { state: 'stale' };
export type ShelfSummaryBinding = { subject: string; type: string | null; locale: string; source: string };

/** One independent observation. Retirement and acknowledgements also discard in-flight pre-write reads. */
export function shelfSummaryObservation(
  binding: ShelfSummaryBinding,
  current: () => boolean,
  read: () => Promise<ShelfSummaryCurrentRead>,
) {
  let value: ShelfSummaryState = { state: 'preparing' };
  let started = false;
  let generation = 0;
  let pending: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: ShelfSummaryState) => {
    value = next;
    listeners.forEach((listener) => listener());
  };
  const refresh = () => {
    if (!current()) return Promise.resolve();
    if (pending) return pending;
    started = true;
    const request = ++generation;
    publish({ state: 'preparing' });
    pending = (async () => {
      try {
        const result = await read();
        if (request !== generation || !current()) return;
        const accepted =
          result.authorizationAgrees &&
          result.sessionSubject === binding.subject &&
          result.requested.type === binding.type &&
          result.requested.locale === binding.locale &&
          result.requested.source === binding.source;
        publish(accepted ? result.page : { state: 'unavailable' });
      } catch {
        if (request === generation && current()) publish({ state: 'unavailable' });
      } finally {
        if (request === generation) pending = undefined;
      }
    })();
    return pending;
  };
  return {
    snapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => (started ? pending : refresh()),
    refresh,
    invalidate: () => {
      if (!current()) return;
      generation++;
      pending = undefined;
      started = true;
      publish({ state: 'stale' });
    },
  };
}
