import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { getLocale } from '../../paraglide/runtime.js';
import type { OwnVotesRead } from './actions';
import { indexOwnVotes, votePairKey, type VotePair } from './inventory';
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

type ReturnState = {
  receipt: OwnVotesReturnReceipt | null;
  depart: (input: Omit<OwnVotesReturnReceipt, 'id' | 'phase' | 'focusVersion'>, phase?: OwnVotesReturnReceipt['phase']) => OwnVotesReturnReceipt;
  begin: (id: string) => boolean;
  owns: (id: string, owner: OwnVotesReturnOwner, phase: OwnVotesReturnReceipt['phase']) => boolean;
  fail: (id: string) => void;
  resolve: (id: string) => number | null;
  clear: (id?: string) => void;
  focusUnchanged: (version: number) => boolean;
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

  const publish = useCallback((next: OwnVotesReturnReceipt | null) => {
    console.log('receipt', receiptRef.current?.phase ?? 'none', '=>', next?.phase ?? 'none');
    receiptRef.current = next;
    setReceipt(next);
  }, []);
  const clear = useCallback((id?: string) => {
    if (id === undefined || receiptRef.current?.id === id) publish(null);
  }, [publish]);
  const depart = useCallback<ReturnState['depart']>((input, phase = 'departed') => {
    const next: OwnVotesReturnReceipt = { ...input, id: crypto.randomUUID(), phase, focusVersion: focusVersion.current };
    publish(next);
    return next;
  }, [publish]);
  const begin = useCallback((id: string) => {
    const current = receiptRef.current;
    if (!current || current.id !== id || (current.phase !== 'arrived' && current.phase !== 'failed')) return false;
    publish({ ...current, phase: 'refreshing' });
    return true;
  }, [publish]);
  const owns = useCallback(
    (id: string, owner: OwnVotesReturnOwner, phase: OwnVotesReturnReceipt['phase']) => {
      const current = receiptRef.current;
      return current?.id === id && current.owner === owner && current.phase === phase;
    },
    [],
  );
  const fail = useCallback((id: string) => {
    const current = receiptRef.current;
    if (current?.id === id && current.phase === 'refreshing') publish({ ...current, phase: 'failed' });
  }, [publish]);
  const resolve = useCallback((id: string) => {
    const current = receiptRef.current;
    if (current?.id !== id || current.phase !== 'refreshing') return null;
    publish({ ...current, phase: 'resolved' });
    return current.focusVersion;
  }, [publish]);
  const focusUnchanged = useCallback((version: number) => focusVersion.current === version, []);

  useEffect(() => {
    if (!router) return;
    const stop = router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
      if (!fromLocation) return;
      const current = receiptRef.current;
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
      else publish(null);
    };
    document.addEventListener('focusin', focus, true);
    window.addEventListener('pageshow', show);
    return () => {
      stop();
      document.removeEventListener('focusin', focus, true);
      window.removeEventListener('pageshow', show);
    };
  }, [router, publish]);

  const value = useMemo<ReturnState>(
    () => ({ receipt, depart, begin, owns, fail, resolve, clear, focusUnchanged }),
    [receipt, depart, begin, owns, fail, resolve, clear, focusUnchanged],
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
  if (receipt) console.log('receipt current', receipt.phase, currentOwner, valid);
  useEffect(() => {
    if (receipt && onRatings && receipt.phase !== 'bfcache-away' && !valid) state.clear(receipt.id);
  }, [receipt, valid, onRatings, state]);
  return onRatings && valid ? receipt : null;
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
      state.depart(
        {
          historyKey,
          pair: selected,
          owner: activeOwner,
        },
      );
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
      console.log('read complete', returnReceipt.phase, ownsAfterRead, read?.state ?? 'rejected');
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
          console.log('resolved inspection', outcome.kind);
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
