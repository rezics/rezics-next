import type { QueryClient } from '@tanstack/react-query';
import { browserObservation } from '../../reader/lifetime/index';
import type { ReporterHistoryQuery } from './model';

export type Movement = 'next' | 'previous' | 'first' | 'selection' | 'restart';
export const sameCoordinate = (a: ReporterHistoryQuery, b: ReporterHistoryQuery) =>
  a.cursor === b.cursor && a.reportId === b.reportId;

/** Operands only: eight admitted predecessors, current, and one uncommitted target. */
export function createHistoryCoordinates() {
  let owner: symbol | undefined;
  let predecessors: ReporterHistoryQuery[] = [];
  let current: ReporterHistoryQuery | undefined;
  let staged: { query: ReporterHistoryQuery; movement: Movement; id: symbol } | undefined;
  const clear = () => {
    owner = undefined;
    predecessors = [];
    current = undefined;
    staged = undefined;
  };
  return {
    clear,
    claim: (identity: symbol) => {
      owner = identity;
    },
    retire: (identity: symbol) => {
      if (owner === identity) clear();
    },
    previous: () => predecessors.at(-1),
    stage(query: ReporterHistoryQuery, movement: Movement) {
      staged = { query: { ...query }, movement, id: Symbol() };
    },
    capture: (query: ReporterHistoryQuery) => (staged && sameCoordinate(staged.query, query) ? staged.id : undefined),
    acceptsAddress: (query: ReporterHistoryQuery) =>
      !!((staged && sameCoordinate(staged.query, query)) || (current && sameCoordinate(current, query))),
    admit(query: ReporterHistoryQuery, ticket?: symbol) {
      if (staged && staged.id === ticket && sameCoordinate(staged.query, query)) {
        if (staged.movement === 'previous') predecessors.pop();
        else if (staged.movement === 'next' && current) predecessors = [...predecessors, current].slice(-8);
        else predecessors = [];
        current = { ...query };
        staged = undefined;
      } else if (!current || !sameCoordinate(current, query)) {
        clear();
        current = { ...query };
      }
    },
  };
}
export type HistoryCoordinates = ReturnType<typeof createHistoryCoordinates>;
const visits = new WeakMap<QueryClient, ReturnType<typeof createRouteCoordinates>>();
function createRouteCoordinates(cache: QueryClient) {
  const coordinates = createHistoryCoordinates();
  const browser = browserObservation(cache);
  let observation = browser.getSnapshot();
  let locale: string | undefined;
  let source: string | undefined;
  let router: object | undefined;
  let cancelFocus = () => {};
  let status: string | undefined;
  let returning = false;
  const clear = () => {
    cancelFocus();
    coordinates.clear();
    source = undefined;
    status = undefined;
    returning = false;
  };
  // Reuse the installed browser observation; no independent session observer.
  browser.subscribeCache((event) => {
    const next = browser.getSnapshot();
    const admission = event.query.queryKey[0] === 'exposure' && event.query.queryKey[1] === 'viewer';
    const replaced =
      event.type === 'removed' ||
      (event.type === 'updated' && ['success', 'error', 'setState'].includes(event.action.type));
    if (next !== observation || (admission && replaced)) clear();
    observation = next;
  });
  observation = browser.getSnapshot();
  return {
    ...coordinates,
    cancelFocus: (cancel: () => void) => {
      cancelFocus = cancel;
    },
    isRouter: (candidate: object) => router === candidate,
    clear,
    eligible(nextLocale: string, nextSource?: string) {
      if (locale !== nextLocale || (source !== undefined && nextSource !== undefined && source !== nextSource)) clear();
      locale = nextLocale;
      if (nextSource !== undefined) source = nextSource;
    },
    bind(nextRouter: object) {
      if (router === nextRouter) return false;
      clear();
      router = nextRouter;
      return true;
    },
    status(reportId: string) {
      status = reportId;
    },
    navigating(path: string, query: ReporterHistoryQuery | null) {
      if (status && path === `/moderation/reports/${status}`) {
        status = undefined;
        returning = true;
        return;
      }
      if (
        path.replace(/\/$/, '') === '/moderation/reports' &&
        query &&
        (coordinates.capture(query) || (returning && coordinates.acceptsAddress(query)))
      ) {
        returning = false;
        return;
      }
      clear();
    },
  };
}
export function routeHistoryCoordinates(cache: QueryClient) {
  let visit = visits.get(cache);
  if (!visit) {
    visit = createRouteCoordinates(cache);
    visits.set(cache, visit);
  }
  return visit;
}
