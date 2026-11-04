import type { QueryClient } from '@tanstack/react-query';
import { browserObservation, type BrowserReader } from '../../session/observation';
import {
  createPrivateReaderLifetime,
  preparePrivateReaderRead,
  type PrivateReaderNavigation,
  type PrivateReaderRead,
} from '../private-reader-lifetime';
import { reporterHistoryQuery, type ReporterHistoryQuery } from './model';
import type { ReporterHistoryResult } from './read';

export type ReporterHistoryRead = PrivateReaderRead & { result: ReporterHistoryResult };
export type ReporterHistoryReader = (query: ReporterHistoryQuery) => Promise<ReporterHistoryRead>;
export type ReporterHistoryVisit = ReporterHistoryRead & {
  query: ReporterHistoryQuery;
  locale: string;
  generation: string;
  browserReader?: BrowserReader;
};
export type ReporterHistoryNavigation = PrivateReaderNavigation & {
  /** Served routes commit operands and prepare a new visit. They never invoke this visit's local reader. */
  request?: (query: ReporterHistoryQuery) => Promise<void>;
};
export type ReporterHistoryState = ReporterHistoryResult | { state: 'loading' | 'retired' };
const unavailable = { state: 'unavailable' } as const;
const retired = { state: 'retired' } as const;
const key = (query: ReporterHistoryQuery, locale: string) =>
  JSON.stringify(['reporter-history', locale, query.cursor ?? null, query.reportId ?? null]);

/** Capture the independent browser session before the prepared server read, including the loader/mount gap. */
export async function prepareReporterHistoryVisit(
  cache: QueryClient,
  operands: ReporterHistoryQuery,
  locale: string,
  read: ReporterHistoryReader,
  signal?: AbortSignal,
): Promise<ReporterHistoryVisit> {
  const browser = browserObservation(cache).getSnapshot();
  const query = Object.freeze(reporterHistoryQuery(operands));
  const response = await preparePrivateReaderRead(
    cache,
    key(query, locale),
    async () => {
      try {
        return await read(query);
      } catch {
        return { readerOrigin: null, result: unavailable };
      }
    },
    signal,
  );
  return {
    ...response,
    result: response.readerBinding.retired ? { state: 'denied' } : response.result,
    query,
    locale,
    generation: crypto.randomUUID(),
    ...(typeof window !== 'undefined' && browser.state === 'signed-in' ? { browserReader: browser.observation } : {}),
  };
}

/** One visit, one replacement page and one exact selection. No polling, prefetch or accumulated history. */
export function createReporterHistoryJourney(
  cache: QueryClient,
  initial: ReporterHistoryVisit,
  read: ReporterHistoryReader,
  currentLocale: () => string,
  navigation?: ReporterHistoryNavigation,
) {
  const { locale, query: originalQuery, readerOrigin, readerBinding } = initial;
  const owner = createPrivateReaderLifetime(
    cache,
    { ...(readerOrigin === undefined ? {} : { readerOrigin }), ...(readerBinding ? { readerBinding } : {}) },
    key(originalQuery, locale),
    navigation,
  );
  let result: ReporterHistoryState = initial.result;
  let query = originalQuery;
  let pending = query;
  let source = initial.result.state === 'loaded' ? initial.result.nativeSourceFingerprint : null;
  let serverResult: ReporterHistoryState = readerOrigin ? initial.result : unavailable;
  let busy = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  const browser = browserObservation(cache);
  let reader = initial.browserReader;
  const browserCurrent = () => {
    const next = browser.getSnapshot();
    return (
      !reader ||
      (next.state === 'signed-in' && next.observation.id === reader.id && next.observation.subject === reader.subject)
    );
  };
  const publish = (next: ReporterHistoryState) => {
    serverResult = next;
    result = next;
    for (const listener of listeners) listener();
  };
  const healthy = () => {
    if (currentLocale() !== locale || !browserCurrent()) owner.retire();
    return owner.healthy();
  };
  const snapshot = (): ReporterHistoryState => {
    if (!healthy()) {
      result = retired;
      serverResult = retired;
      source = null;
      return retired;
    }
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
    if (navigation?.request) {
      // The route loader is the sole publisher. Retire before handing off, even for same-address reloads.
      owner.retire();
      await navigation.request(pending);
      return;
    }
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
    serverSnapshot: () => serverResult,
    operands: () => pending,
    retire: () => {
      owner.retire();
      publish(retired);
      source = null;
    },
    isConnected: current,
    isCurrent: () => current() && owner.available() && snapshot().state === 'loaded',
    subscribe(listener: () => void) {
      listeners.add(listener);
      const stopBrowser = browser.subscribeCache(() => {
        if (!browserCurrent()) owner.retire();
      });
      const observed = browser.getSnapshot();
      if (!reader && observed.state === 'signed-in') reader = observed.observation;
      const stop = owner.subscribe(() => {
        if (!owner.healthy()) {
          source = null;
          publish(retired);
        } else listener();
      });
      return () => {
        listeners.delete(listener);
        generation++;
        stop();
        stopBrowser();
      };
    },
    retry: () => (['unavailable', 'denied'].includes(snapshot().state) ? request(pending) : Promise.resolve()),
    refresh: () => (snapshot().state === 'loaded' ? request(query) : Promise.resolve()),
    next: () => {
      const value = snapshot();
      return value.state === 'loaded' && value.page.nextCursor !== null
        ? request({ ...query, cursor: value.page.nextCursor })
        : Promise.resolve();
    },
    select: (reportId: string) => (snapshot().state === 'loaded' ? request({ ...query, reportId }) : Promise.resolve()),
    // Restart is explicit and also drops the selected ID bound into the expired cursor.
    restart: () => (snapshot().state === 'expired' ? request({}) : Promise.resolve()),
  };
}
