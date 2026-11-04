import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useWorkspaceAdmission, useReaderAddress } from '../../session/reader';
import { discoverySearchHref, type SearchLoaderDeps } from '../search-params';
import {
  SEARCH_WINDOW_STATE, emptySearchWindows, restoreSearchWindows, admitSearchWindow,
  searchWindowPosition, searchWindowNextAllowed, type SearchWindowHistory,
} from './history';
import { searchWindowFocus } from './focus';

const operations = [] as const;
type Transition = { request: string; from: string | null; to: string | null; action: string };
type Visit = { request: string; history: SearchWindowHistory; cursor: string | null; checkpoint?: string | undefined };

/** A single Search visit owns its address history; browser entries carry only its bounded admitted addresses. */
export function useSearchWindow({
  state, locale, session, ready, settled, checkpoint, enabled = true,
}: {
  state: SearchLoaderDeps;
  locale: string;
  session: string | null;
  ready: boolean;
  settled: boolean;
  checkpoint?: string | undefined;
  enabled?: boolean;
}) {
  const router = useRouter({ warn: false });
  const { value: reader } = useWorkspaceAdmission(operations);
  const address = useReaderAddress(null, undefined, locale);
  const firstHref = discoverySearchHref(locale, { ...state, cursor: undefined });
  const request = JSON.stringify([firstHref, session, reader.subject, reader.viewer, reader.observation?.id]);
  const cursor = state.cursor ?? null;
  const visit = useRef<Visit | undefined>(undefined);
  const pending = useRef<Transition | undefined>(undefined);
  const focus = useRef<ReturnType<typeof searchWindowFocus> | undefined>(undefined);
  focus.current ??= searchWindowFocus();
  const navigationRef = useRef<HTMLElement>(null);
  const regionRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const stored = () => typeof window === 'undefined' ? undefined : window.history.state?.[SEARCH_WINDOW_STATE];
  const persisted = () => {
    const envelope = stored();
    return envelope?.request === request ? restoreSearchWindows(envelope.history, firstHref) : emptySearchWindows(firstHref);
  };
  const changedOwner = visit.current?.request !== request;
  if (!visit.current || changedOwner) {
    if (visit.current) focus.current.retire();
    pending.current = undefined;
    visit.current = { request, cursor, history: persisted() };
  } else if (visit.current.cursor !== cursor) {
    const transition = pending.current;
    // Browser traversal uses the entry being entered. An activated transition carries the same admitted list.
    visit.current = { ...visit.current, cursor, history: transition?.request === request && transition.to === cursor ? visit.current.history : persisted() };
    if (transition && transition.to !== cursor) {
      pending.current = undefined;
      focus.current.retire();
    }
  }
  const current = visit.current;
  if (ready && enabled) {
    if (checkpoint && current.checkpoint && checkpoint !== current.checkpoint) {
      current.history = emptySearchWindows(firstHref);
      pending.current = undefined;
      focus.current.retire();
    }
    current.checkpoint = checkpoint;
    current.history = admitSearchWindow(current.history, state.cursor, pending.current?.from);
  }
  const position = searchWindowPosition(current.history, state.cursor);

  useLayoutEffect(() => {
    if (!enabled || !settled) return;
    const transition = pending.current;
    if (transition?.request === request && transition.to === cursor) {
      pending.current = undefined;
      setBusy(false);
      focus.current?.settle(request, cursor, navigationRef.current, regionRef.current);
    } else if (!transition) setBusy(false);
    if (!ready || typeof window === 'undefined') return;
    // Preserve the router's own entry key and scroll state. No navigation or request is dispatched here.
    window.history.replaceState({
      ...window.history.state,
      [SEARCH_WINDOW_STATE]: { request, history: current.history },
    }, '');
  }, [request, cursor, ready, settled, enabled, checkpoint, current.history]);

  useEffect(() => {
    if (changedOwner) setBusy(false);
  }, [request]);
  useEffect(() => () => {
    focus.current?.retire();
    pending.current = undefined;
  }, []);
  useEffect(() => {
    if (!router) return;
    return router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      const href = toLocation.publicHref;
      const target = pending.current;
      const expected = target ? discoverySearchHref(locale, { ...state, cursor: target.to ?? undefined }) : undefined;
      // Every unactivated navigation, including opening a result, retires focus immediately.
      if (!expected || href.split('#')[0] !== expected) {
        pending.current = undefined;
        focus.current?.retire();
        setBusy(false);
      }
    });
  }, [router, request, cursor, locale]);

  function activate(event: React.MouseEvent<HTMLAnchorElement>, target: string | undefined, action: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!router) return; // The exact address remains a native link before hydration.
    event.preventDefault();
    if (!enabled || pending.current || !address.isCurrent() || (target ?? null) === cursor) return;
    const to = target ?? null;
    focus.current?.capture(request, to, action, event.currentTarget);
    pending.current = { request, from: cursor, to, action };
    setBusy(true);
    const href = discoverySearchHref(locale, { ...state, cursor: target });
    void router.navigate({ href }).catch(() => {
      if (pending.current?.request !== request || pending.current.to !== to) return;
      pending.current = undefined;
      setBusy(false);
      focus.current?.retire();
    });
  }
  return {
    firstHref,
    history: current.history,
    position,
    busy,
    navigationRef,
    regionRef,
    activate,
    nextAllowed: (next: string | null | undefined) => searchWindowNextAllowed(current.history, state.cursor, next),
  };
}
export type SearchWindowNavigation = ReturnType<typeof useSearchWindow>;
