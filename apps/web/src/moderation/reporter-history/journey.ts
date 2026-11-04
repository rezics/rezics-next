import type { QueryClient } from '@tanstack/react-query';
import { createPrivateReaderLifetime, preparePrivateReaderRead, type PrivateReaderNavigation, type PrivateReaderRead } from '../private-reader-lifetime';
import { reporterHistoryQuery, type ReporterHistoryQuery } from './model';
import type { ReporterHistoryResult } from './read';

export type ReporterHistoryRead = PrivateReaderRead & { result: ReporterHistoryResult };
export type ReporterHistoryReader = (query: ReporterHistoryQuery) => Promise<ReporterHistoryRead>;
export type ReporterHistoryVisit = ReporterHistoryRead & { query: ReporterHistoryQuery; locale: string; generation: string };
export type ReporterHistoryState = ReporterHistoryResult | { state: 'loading' | 'retired' };
const unavailable = { state: 'unavailable' } as const;
const retired = { state: 'retired' } as const;
const key = (query: ReporterHistoryQuery, locale: string) => JSON.stringify(['reporter-history', locale, query.cursor ?? null, query.reportId ?? null]);

/** Capture the independent browser session before the prepared server read, including the loader/mount gap. */
export async function prepareReporterHistoryVisit(
  cache: QueryClient,
  operands: ReporterHistoryQuery,
  locale: string,
  read: ReporterHistoryReader,
  signal?: AbortSignal,
): Promise<ReporterHistoryVisit> {
  const query = Object.freeze(reporterHistoryQuery(operands));
  const response = await preparePrivateReaderRead(cache, key(query, locale), async () => {
    try { return await read(query); }
    catch { return { readerOrigin: null, result: unavailable }; }
  }, signal);
  return { ...response, query, locale, generation: crypto.randomUUID() };
}

/** One visit, one replacement page and one exact selection. No polling, prefetch or accumulated history. */
export function createReporterHistoryJourney(
  cache: QueryClient,
  initial: ReporterHistoryVisit,
  read: ReporterHistoryReader,
  currentLocale: () => string,
  navigation?: PrivateReaderNavigation,
) {
  const owner = createPrivateReaderLifetime(cache, initial, key(initial.query, initial.locale), navigation);
  let result: ReporterHistoryState = initial.result;
  let query = initial.query;
  let pending = query;
  let source = initial.result.state === 'loaded' ? initial.result.nativeSourceFingerprint : null;
  let busy = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ReporterHistoryState) => {
    result = next;
    for (const listener of listeners) listener();
  };
  const healthy = () => {
    if (currentLocale() !== initial.locale) owner.retire();
    return owner.healthy();
  };
  const snapshot = (): ReporterHistoryState => {
    if (!healthy()) return retired;
    if (result.state === 'loaded' && !owner.available()) return unavailable;
    return result;
  };
  const current = () => healthy() && owner.isCurrent();
  async function request(operands: ReporterHistoryQuery) {
    if (!current() || busy) return;
    busy = true;
    pending = Object.freeze(reporterHistoryQuery(operands));
    const attempt = ++generation;
    const ticket = owner.ticket();
    // Drop the old page before any asynchronous work, including failed continuations.
    publish({ state: 'loading' });
    try {
      const next = await read(pending);
      if (!current() || !owner.owns(ticket) || attempt !== generation) return;
      if (!next.readerOrigin && next.result.state === 'unavailable') return publish(unavailable);
      if (!(await owner.accepts(next))) return owner.retire();
      if (!current() || !owner.owns(ticket) || attempt !== generation) return;
      if (next.result.state === 'loaded') {
        if (source !== null && source !== next.result.nativeSourceFingerprint) return owner.retire();
        source = next.result.nativeSourceFingerprint;
      }
      query = pending;
      publish(next.result);
    } catch {
      if (current() && owner.owns(ticket) && attempt === generation) publish(unavailable);
    } finally {
      if (attempt === generation) busy = false;
    }
  }
  return {
    snapshot,
    // Admission remains mandatory on the browser, even after a server rendering.
    serverSnapshot: () => initial.readerOrigin ? initial.result : unavailable,
    retire: owner.retire,
    isCurrent: () => current() && owner.available() && snapshot().state === 'loaded',
    subscribe(listener: () => void) {
      listeners.add(listener);
      const stop = owner.subscribe(listener);
      return () => { listeners.delete(listener); generation++; stop(); };
    },
    retry: () => snapshot().state === 'unavailable' ? request(pending) : Promise.resolve(),
    refresh: () => snapshot().state === 'loaded' ? request(query) : Promise.resolve(),
    next: () => {
      const value = snapshot();
      return value.state === 'loaded' && value.page.nextCursor !== null
        ? request({ ...query, cursor: value.page.nextCursor }) : Promise.resolve();
    },
    select: (reportId: string) => snapshot().state === 'loaded'
      ? request({ ...query, reportId }) : Promise.resolve(),
    // Restart is explicit and also drops the selected ID bound into the expired cursor.
    restart: () => snapshot().state === 'expired' ? request({}) : Promise.resolve(),
  };
}
