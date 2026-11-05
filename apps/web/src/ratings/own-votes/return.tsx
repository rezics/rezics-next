import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { getLocale } from '../../paraglide/runtime.js';
import type { OwnVotesRead } from './actions';
import { indexOwnVotes, OWN_VOTES_PREDECESSOR_LIMIT, votePairKey, type VotePair } from './inventory';
import type { OwnVoteEntry, OwnVotesPage } from './types';

export type OwnVotesReturnOwner = {
  visitKey: string;
  responseVersion: number;
  subject: string | null;
  cursor: string | null;
  locale: string;
  source: string;
  admissionCurrent: () => boolean;
  eligible: () => boolean;
  canRead: () => boolean;
  validateResult: (result: unknown) => OwnVotesRead | null;
};

export type OwnVotesReturnOutcome =
  | { kind: 'refreshed'; pair: null }
  | { kind: 'found'; pair: VotePair }
  | { kind: 'missing'; pair: VotePair };

export type OwnVotesReturnReceipt = {
  id: string;
  historyKey: string;
  pair: VotePair | null;
  owner: OwnVotesReturnOwner;
  phase: 'departed' | 'bfcache-away' | 'arrived' | 'refreshing' | 'failed' | 'resolved';
  focusVersion: number;
};

export type OwnVotesCoordinateMove = {
  kind: 'first' | 'previous' | 'continue';
  cursor: string | null;
};

type PendingCoordinateMove = OwnVotesCoordinateMove & {
  id: string;
  authorityKey: string;
  from: string | null;
  responseVersion: number;
  previousIndex: number;
  readState: 'staged' | 'failed';
};

type CoordinateVisit = {
  authorityKey: string;
  cursors: Array<string | null>;
  currentIndex: number;
  pending: PendingCoordinateMove | null;
};

type OwnVotesCoordinateSnapshot = {
  hasPrevious: boolean;
  previousCursor: string | null;
  pending: PendingCoordinateMove | null;
};

type ReturnState = {
  receipt: OwnVotesReturnReceipt | null;
  depart: (
    input: Omit<OwnVotesReturnReceipt, 'id' | 'phase' | 'focusVersion'>,
    phase?: OwnVotesReturnReceipt['phase'],
  ) => OwnVotesReturnReceipt;
  begin: (id: string) => boolean;
  owns: (id: string, owner: OwnVotesReturnOwner, phase: OwnVotesReturnReceipt['phase']) => boolean;
  fail: (id: string) => void;
  resolve: (id: string) => number | null;
  clear: (id?: string) => void;
  focusUnchanged: (version: number) => boolean;
  pendingCoordinate: () => PendingCoordinateMove | null;
  coordinates: (authorityKey: string, cursor: string | null) => OwnVotesCoordinateSnapshot;
  stageCoordinateMove: (
    authorityKey: string,
    cursor: string | null,
    responseVersion: number,
    move: OwnVotesCoordinateMove,
  ) => string | null;
  admitCoordinate: (authorityKey: string, cursor: string | null) => void;
  failCoordinateRead: (id: string) => void;
  cancelCoordinateMove: (id: string) => void;
  clearCoordinates: () => void;
};

const noReturnState: ReturnState = {
  receipt: null,
  depart: () => {
    throw new Error('My ratings return context is not mounted');
  },
  begin: () => false,
  owns: () => false,
  fail: () => undefined,
  resolve: () => null,
  clear: () => undefined,
  focusUnchanged: () => false,
  pendingCoordinate: () => null,
  coordinates: () => ({ hasPrevious: false, previousCursor: null, pending: null }),
  stageCoordinateMove: () => null,
  admitCoordinate: () => undefined,
  failCoordinateRead: () => undefined,
  cancelCoordinateMove: () => undefined,
  clearCoordinates: () => undefined,
};
const OwnVotesReturnContext = createContext<ReturnState>(noReturnState);
const localePrefix = /^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/;

function routePath(pathname: string) {
  return pathname.replace(localePrefix, '').replace(/\/$/, '') || '/';
}

function locationKey(location: { state: unknown }): string | null {
  if (!location.state || typeof location.state !== 'object') return null;
  const key = (location.state as { key?: unknown }).key;
  return typeof key === 'string' ? key : null;
}

function sameReturnAddress(
  location: { pathname: string; search: unknown; state: unknown },
  receipt: OwnVotesReturnReceipt,
) {
  const search =
    location.search && typeof location.search === 'object' ? (location.search as Record<string, unknown>) : {};
  const cursor = typeof search.cursor === 'string' ? search.cursor : null;
  return (
    routePath(location.pathname) === '/library/ratings' &&
    locationKey(location) === receipt.historyKey &&
    cursor === receipt.owner.cursor
  );
}

export function OwnVotesReturnProvider({ children }: { children: ReactNode }) {
  const router = useRouter({ warn: false });
  const [receipt, setReceipt] = useState<OwnVotesReturnReceipt | null>(null);
  const receiptRef = useRef(receipt);
  const focusVersion = useRef(0);
  const coordinateVisit = useRef<CoordinateVisit | null>(null);
  const [coordinateVersion, setCoordinateVersion] = useState(0);

  const publish = useCallback((next: OwnVotesReturnReceipt | null) => {
    receiptRef.current = next;
    setReceipt(next);
  }, []);
  const clear = useCallback(
    (id?: string) => {
      if (id === undefined || receiptRef.current?.id === id) publish(null);
    },
    [publish],
  );
  const depart = useCallback<ReturnState['depart']>(
    (input, phase = 'departed') => {
      const next: OwnVotesReturnReceipt = {
        ...input,
        id: crypto.randomUUID(),
        phase,
        focusVersion: focusVersion.current,
      };
      publish(next);
      return next;
    },
    [publish],
  );
  const begin = useCallback(
    (id: string) => {
      const current = receiptRef.current;
      if (!current || current.id !== id || (current.phase !== 'arrived' && current.phase !== 'failed')) return false;
      publish({ ...current, phase: 'refreshing' });
      return true;
    },
    [publish],
  );
  const owns = useCallback((id: string, owner: OwnVotesReturnOwner, phase: OwnVotesReturnReceipt['phase']) => {
    const current = receiptRef.current;
    return current?.id === id && current.owner === owner && current.phase === phase;
  }, []);
  const fail = useCallback(
    (id: string) => {
      const current = receiptRef.current;
      if (current?.id === id && current.phase === 'refreshing') publish({ ...current, phase: 'failed' });
    },
    [publish],
  );
  const resolve = useCallback(
    (id: string) => {
      const current = receiptRef.current;
      if (current?.id !== id || current.phase !== 'refreshing') return null;
      publish({ ...current, phase: 'resolved' });
      return current.focusVersion;
    },
    [publish],
  );
  const focusUnchanged = useCallback((version: number) => focusVersion.current === version, []);
  const publishCoordinates = useCallback((next: CoordinateVisit | null) => {
    coordinateVisit.current = next;
    setCoordinateVersion((version) => version + 1);
  }, []);
  const pendingCoordinate = useCallback(() => coordinateVisit.current?.pending ?? null, []);
  const coordinates = useCallback((authorityKey: string, cursor: string | null): OwnVotesCoordinateSnapshot => {
    const visit = coordinateVisit.current;
    if (!visit || visit.authorityKey !== authorityKey || visit.cursors[visit.currentIndex] !== cursor)
      return { hasPrevious: false, previousCursor: null, pending: visit?.pending ?? null };
    return {
      hasPrevious: visit.currentIndex > 0,
      previousCursor: visit.currentIndex > 0 ? visit.cursors[visit.currentIndex - 1]! : null,
      pending: visit.pending,
    };
  }, []);
  const stageCoordinateMove = useCallback<ReturnState['stageCoordinateMove']>(
    (authorityKey, cursor, responseVersion, move) => {
      const visit = coordinateVisit.current;
      if (!visit || visit.authorityKey !== authorityKey || visit.pending) return null;
      const currentCursor = visit.cursors[visit.currentIndex];
      if (currentCursor !== cursor && !(move.kind === 'first' && move.cursor === null)) return null;
      if (move.kind === 'first' && move.cursor !== null) return null;
      if (
        move.kind === 'previous' &&
        (visit.currentIndex === 0 || visit.cursors[visit.currentIndex - 1] !== move.cursor)
      )
        return null;
      const pending: PendingCoordinateMove = {
        ...move,
        id: crypto.randomUUID(),
        authorityKey,
        from: cursor,
        responseVersion,
        previousIndex: visit.currentIndex,
        readState: 'staged',
      };
      publishCoordinates({ ...visit, pending });
      return pending.id;
    },
    [publishCoordinates],
  );
  const admitCoordinate = useCallback(
    (authorityKey: string, cursor: string | null) => {
      const visit = coordinateVisit.current;
      if (visit?.authorityKey === authorityKey && visit.pending?.authorityKey === authorityKey) {
        const pending = visit.pending;
        if (pending.cursor === cursor) {
          let cursors: Array<string | null>;
          let currentIndex: number;
          if (pending.kind === 'first') {
            cursors = [null];
            currentIndex = 0;
          } else if (pending.kind === 'previous') {
            cursors = visit.cursors.slice(0, pending.previousIndex);
            currentIndex = cursors.length - 1;
          } else {
            cursors = [...visit.cursors.slice(0, pending.previousIndex + 1), cursor];
            if (cursors.length > OWN_VOTES_PREDECESSOR_LIMIT + 1)
              cursors = cursors.slice(cursors.length - (OWN_VOTES_PREDECESSOR_LIMIT + 1));
            currentIndex = cursors.length - 1;
          }
          publishCoordinates({ authorityKey, cursors, currentIndex, pending: null });
          return;
        }
      }
      if (visit?.authorityKey === authorityKey && visit.cursors[visit.currentIndex] === cursor) return;
      publishCoordinates({ authorityKey, cursors: [cursor], currentIndex: 0, pending: null });
    },
    [publishCoordinates],
  );
  const cancelCoordinateMove = useCallback(
    (id: string) => {
      const visit = coordinateVisit.current;
      if (visit?.pending?.id === id) publishCoordinates({ ...visit, pending: null });
    },
    [publishCoordinates],
  );
  const failCoordinateRead = useCallback(
    (id: string) => {
      const visit = coordinateVisit.current;
      if (visit?.pending?.id === id && visit.pending.readState !== 'failed')
        publishCoordinates({ ...visit, pending: { ...visit.pending, readState: 'failed' } });
    },
    [publishCoordinates],
  );
  const clearCoordinates = useCallback(() => {
    if (coordinateVisit.current) publishCoordinates(null);
  }, [publishCoordinates]);

  useEffect(() => {
    if (!router) return;
    const stop = router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
      if (!fromLocation) return;
      const current = receiptRef.current;
      const fromPath = routePath(fromLocation.pathname);
      const toPath = routePath(toLocation.pathname);
      if (fromPath === '/library/ratings' && toPath === '/library/ratings') {
        const pending = coordinateVisit.current?.pending;
        const fromSearch = fromLocation.search as Record<string, unknown>;
        const toSearch = toLocation.search as Record<string, unknown>;
        const fromCursor = typeof fromSearch.cursor === 'string' ? fromSearch.cursor : null;
        const toCursor = typeof toSearch.cursor === 'string' ? toSearch.cursor : null;
        if (!pending || pending.from !== fromCursor || pending.cursor !== toCursor) clearCoordinates();
      } else if (fromPath === '/library/ratings' && !toPath.startsWith('/subjects/')) {
        clearCoordinates();
      } else if (fromPath !== '/library/ratings' && toPath === '/library/ratings') {
        const returning =
          !!current &&
          current.phase === 'departed' &&
          sameReturnAddress(toLocation, current) &&
          current.owner.locale === getLocale() &&
          current.owner.eligible();
        if (!returning) clearCoordinates();
      }
      if (!current) return;
      if (
        current.phase === 'departed' &&
        current.historyKey === locationKey(fromLocation) &&
        routePath(fromLocation.pathname) === '/library/ratings' &&
        routePath(toLocation.pathname).startsWith('/subjects/')
      )
        return;
      if (
        current.phase === 'departed' &&
        sameReturnAddress(toLocation, current) &&
        current.owner.locale === getLocale() &&
        current.owner.eligible()
      ) {
        publish({ ...current, phase: 'arrived', focusVersion: focusVersion.current });
      } else {
        publish(null);
      }
    });
    const focus = () => {
      const current = receiptRef.current;
      if (current && current.phase !== 'bfcache-away') focusVersion.current += 1;
    };
    const show = (event: PageTransitionEvent) => {
      const current = receiptRef.current;
      if (!event.persisted || current?.phase !== 'bfcache-away') return;
      if (
        current.historyKey === locationKey(router.state.location) &&
        current.owner.locale === getLocale() &&
        current.owner.eligible()
      )
        publish({ ...current, phase: 'arrived', focusVersion: focusVersion.current });
      else {
        publish(null);
        clearCoordinates();
      }
    };
    document.addEventListener('focusin', focus, true);
    window.addEventListener('pageshow', show);
    return () => {
      stop();
      document.removeEventListener('focusin', focus, true);
      window.removeEventListener('pageshow', show);
    };
  }, [router, publish, clearCoordinates]);

  const value = useMemo<ReturnState>(
    () => ({
      receipt,
      depart,
      begin,
      owns,
      fail,
      resolve,
      clear,
      focusUnchanged,
      pendingCoordinate,
      coordinates,
      stageCoordinateMove,
      admitCoordinate,
      failCoordinateRead,
      cancelCoordinateMove,
      clearCoordinates,
    }),
    [
      receipt,
      depart,
      begin,
      owns,
      fail,
      resolve,
      clear,
      focusUnchanged,
      pendingCoordinate,
      coordinates,
      stageCoordinateMove,
      admitCoordinate,
      failCoordinateRead,
      cancelCoordinateMove,
      clearCoordinates,
      coordinateVersion,
    ],
  );
  return <OwnVotesReturnContext.Provider value={value}>{children}</OwnVotesReturnContext.Provider>;
}

export function useOwnVotesReturnReceipt(historyKey: string, cursor: string | null, locale: string) {
  const pathname = useRouterState({ select: (routerState) => routerState.location.pathname });
  const state = useContext(OwnVotesReturnContext);
  const receipt = state.receipt;
  const onRatings = routePath(pathname) === '/library/ratings';
  const currentOwner =
    receipt?.phase === 'refreshing' || receipt?.phase === 'resolved'
      ? receipt.owner.admissionCurrent()
      : receipt?.owner.eligible();
  const valid =
    !!receipt &&
    onRatings &&
    receipt.phase !== 'bfcache-away' &&
    receipt.historyKey === historyKey &&
    receipt.owner.cursor === cursor &&
    receipt.owner.locale === locale &&
    receipt.owner.source.length > 0 &&
    currentOwner;
  useEffect(() => {
    if (receipt && onRatings && receipt.phase !== 'bfcache-away' && !valid) state.clear(receipt.id);
  }, [receipt, valid, onRatings, state]);
  return onRatings && valid ? receipt : null;
}

export function useOwnVotesCoordinates(authorityKey: string, cursor: string | null) {
  const state = useContext(OwnVotesReturnContext);
  return {
    ...state.coordinates(authorityKey, cursor),
    stage: (responseVersion: number, move: OwnVotesCoordinateMove) =>
      state.stageCoordinateMove(authorityKey, cursor, responseVersion, move),
    admit: (admittedCursor: string | null) => state.admitCoordinate(authorityKey, admittedCursor),
    fail: state.failCoordinateRead,
    cancel: state.cancelCoordinateMove,
    retire: state.clearCoordinates,
  };
}

export function useOwnVotesPendingCoordinate(cursor: string | null) {
  const pending = useContext(OwnVotesReturnContext).pendingCoordinate();
  return pending?.readState === 'staged' && pending.cursor === cursor;
}

export function useOwnVotesReturn({
  visitKey,
  cursor,
  locale,
  owner,
  isCurrent,
  refresh,
  receipt,
  onResolved,
  onFocus,
}: {
  visitKey: string;
  cursor: string | null;
  locale: string;
  owner: () => OwnVotesReturnOwner;
  isCurrent: () => boolean;
  refresh: () => Promise<unknown>;
  receipt: OwnVotesReturnReceipt | null;
  onResolved: (
    outcome: OwnVotesReturnOutcome,
    index: Map<string, OwnVoteEntry>,
    page: OwnVotesPage,
    read: OwnVotesRead,
  ) => void;
  onFocus: (outcome: OwnVotesReturnOutcome) => void;
}) {
  const router = useRouter({ warn: false });
  const state = useContext(OwnVotesReturnContext);
  const pair = useRef<{ visitKey: string; value: VotePair | null }>({ visitKey, value: null });
  const latestOwner = useRef(owner);
  latestOwner.current = owner;

  useEffect(() => {
    pair.current = { visitKey, value: null };
  }, [visitKey]);

  useEffect(() => {
    if (!router || !state) return;
    const stop = router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
      if (!fromLocation) return;
      if (routePath(fromLocation.pathname) !== '/library/ratings') return;
      const destination = routePath(toLocation.pathname);
      if (!destination.startsWith('/subjects/')) {
        state.clear();
        return;
      }
      const activeOwner = latestOwner.current();
      const search = fromLocation.search as Record<string, unknown>;
      const addressCursor = typeof search.cursor === 'string' ? search.cursor : null;
      const historyKey = locationKey(fromLocation);
      if (!historyKey || activeOwner.cursor !== addressCursor || !activeOwner.eligible()) {
        state.clear();
        return;
      }
      const selected = pair.current.visitKey === visitKey ? pair.current.value : null;
      state.depart({
        historyKey,
        pair: selected,
        owner: activeOwner,
      });
    });
    const hide = (event: PageTransitionEvent) => {
      if (!event.persisted || !isCurrent()) return;
      const activeOwner = latestOwner.current();
      if (!activeOwner.eligible()) return;
      const location = router.state.location;
      const search = location.search as Record<string, unknown>;
      const addressCursor = typeof search.cursor === 'string' ? search.cursor : null;
      const historyKey = locationKey(location);
      if (!historyKey || activeOwner.cursor !== addressCursor) return;
      state.depart(
        {
          historyKey,
          pair: pair.current.visitKey === visitKey ? pair.current.value : null,
          owner: activeOwner,
        },
        'bfcache-away',
      );
    };
    window.addEventListener('pagehide', hide);
    return () => {
      stop();
      window.removeEventListener('pagehide', hide);
    };
  }, [router, state, visitKey, isCurrent]);

  const returnReceipt = receipt && state ? receipt : null;
  const pending =
    returnReceipt !== null &&
    returnReceipt.owner.cursor === cursor &&
    returnReceipt.owner.locale === locale &&
    ['arrived', 'refreshing', 'failed'].includes(returnReceipt.phase);

  const run = useCallback(async () => {
    if (!returnReceipt || !state || !state.begin(returnReceipt.id)) return;
    if (!returnReceipt.owner.eligible()) {
      state.clear(returnReceipt.id);
      return;
    }
    const requestOwner = owner();
    const ownsRequest = () => {
      return state.owns(returnReceipt.id, returnReceipt.owner, 'refreshing') && requestOwner.canRead();
    };
    try {
      const result = await refresh();
      const ownsAfterRead = ownsRequest();
      const read = ownsAfterRead ? requestOwner.validateResult(result) : null;
      if (!ownsAfterRead) {
        state.clear(returnReceipt.id);
        return;
      }
      if (!read || read.state === 'unavailable') {
        state.fail(returnReceipt.id);
        return;
      }
      if (read.state !== 'ready') {
        state.clear(returnReceipt.id);
        return;
      }
      let outcome: OwnVotesReturnOutcome = { kind: 'refreshed', pair: null };
      if (returnReceipt.pair) {
        try {
          const index = indexOwnVotes(read.page);
          outcome = index.has(votePairKey(returnReceipt.pair))
            ? { kind: 'found', pair: returnReceipt.pair }
            : { kind: 'missing', pair: returnReceipt.pair };
          const focusVersion = state.resolve(returnReceipt.id);
          if (focusVersion === null) return;
          onResolved(outcome, index, read.page, read);
          requestAnimationFrame(() => {
            if (
              state.owns(returnReceipt.id, returnReceipt.owner, 'resolved') &&
              state.focusUnchanged(focusVersion) &&
              requestOwner.canRead() &&
              requestOwner.validateResult(result) === read
            )
              onFocus(outcome);
            state.clear(returnReceipt.id);
          });
          return;
        } catch {
          state.fail(returnReceipt.id);
          return;
        }
      }
      const focusVersion = state.resolve(returnReceipt.id);
      if (focusVersion === null) return;
      onResolved(outcome, indexOwnVotes(read.page), read.page, read);
      requestAnimationFrame(() => {
        if (
          state.owns(returnReceipt.id, returnReceipt.owner, 'resolved') &&
          state.focusUnchanged(focusVersion) &&
          requestOwner.canRead() &&
          requestOwner.validateResult(result) === read
        )
          onFocus(outcome);
        state.clear(returnReceipt.id);
      });
    } catch {
      if (ownsRequest()) state.fail(returnReceipt.id);
      else state.clear(returnReceipt.id);
    }
  }, [returnReceipt, state, owner, refresh, onResolved, onFocus]);

  useEffect(() => {
    if (pending && returnReceipt?.phase === 'arrived') void run();
  }, [pending, returnReceipt, run]);

  const retry = useCallback(() => {
    if (pending && returnReceipt?.phase === 'failed') return run();
    return refresh();
  }, [pending, returnReceipt, run, refresh]);

  return {
    pending,
    failed: pending && returnReceipt?.phase === 'failed',
    inspect: (value: VotePair | null) => {
      pair.current = { visitKey, value };
    },
    refresh: retry,
  };
}
