import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useWorkspaceAdmission, useReaderAddress } from '../../session/reader';
import {
  SEARCH_WINDOW_STATE,
  SEARCH_ADDRESS_LIMIT,
  SEARCH_WINDOW_LIMIT,
  emptySearchWindows,
  restoreSearchWindows,
  admitSearchWindow,
  searchWindowPosition,
  searchWindowNextAllowed,
  type SearchWindowHistory,
} from './history';
import { searchWindowFocus } from './focus';

const operations = [] as const;
type Transition = { request: string; from: string | null | undefined; to: string | null; action: string };
type Visit = {
  request: string;
  history: SearchWindowHistory;
  cursor: string | null;
  preparing: string[];
  checkpoint?: string | undefined;
  attemptedFrom?: string | null | undefined;
};

/** A single Search visit owns its address history; browser entries carry only its bounded admitted addresses. */
export function useSearchWindow({
  cursor: requestedCursor,
  href,
  isCurrent = () => true,
  locale,
  session,
  ready,
  settled,
  checkpoint,
  recoverable = false,
  preparing = false,
  enabled = true,
}: {
  cursor: string | undefined;
  href: (cursor?: string) => string;
  isCurrent?: () => boolean;
  locale: string;
  session: string | null;
  ready: boolean;
  settled: boolean;
  checkpoint?: string | undefined;
  recoverable?: boolean;
  preparing?: boolean;
  enabled?: boolean;
}) {
  const router = useRouter({ warn: false });
  const { value: reader, store: admission } = useWorkspaceAdmission(operations);
  const address = useReaderAddress(null, undefined, locale);
  const firstHref = href();
  const request = JSON.stringify([firstHref, session, reader.subject, reader.viewer, reader.observation?.id]);
  const cursor = requestedCursor ?? null;
  const historyEnabled = request.length <= SEARCH_ADDRESS_LIMIT && href(requestedCursor).length <= SEARCH_ADDRESS_LIMIT;
  const visit = useRef<Visit | undefined>(undefined);
  const pending = useRef<Transition | undefined>(undefined);
  const focus = useRef<ReturnType<typeof searchWindowFocus> | undefined>(undefined);
  focus.current ??= searchWindowFocus();
  const navigationRef = useRef<HTMLElement>(null);
  const regionRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const stored = () => (typeof window === 'undefined' ? undefined : window.history.state?.[SEARCH_WINDOW_STATE]);
  const persisted = () => {
    const envelope = stored();
    return envelope?.request === request
      ? restoreSearchWindows(envelope.history, firstHref)
      : emptySearchWindows(firstHref);
  };
  const changedOwner = visit.current?.request !== request;
  if (!visit.current || changedOwner) {
    if (visit.current) focus.current.retire();
    pending.current = undefined;
    visit.current = {
      request,
      cursor,
      preparing: [],
      history: visit.current ? emptySearchWindows(firstHref) : persisted(),
      checkpoint:
        stored()?.request === request && typeof stored()?.checkpoint === 'string' ? stored().checkpoint : undefined,
    };
  } else if (visit.current.cursor !== cursor) {
    const transition = pending.current;
    // Browser traversal uses the entry being entered. An activated transition carries the same admitted list.
    visit.current = {
      ...visit.current,
      cursor,
      attemptedFrom: transition?.request === request && transition.to === cursor ? transition.from : undefined,
      history: transition?.request === request && transition.to === cursor ? visit.current.history : persisted(),
    };
    if (transition && transition.to !== cursor) {
      pending.current = undefined;
      focus.current.retire();
    }
  }
  const current = visit.current;
  const readerCurrent = () => {
    const now = admission.read();
    return now.subject === reader.subject && now.viewer === reader.viewer && now.observation === reader.observation;
  };
  const authoritative = address.isCurrent() && readerCurrent() && isCurrent();
  if (checkpoint && current.checkpoint && checkpoint !== current.checkpoint) {
    current.history = emptySearchWindows(firstHref);
    current.preparing = [];
    current.attemptedFrom = undefined;
    pending.current = undefined;
    focus.current.retire();
  }
  if (checkpoint) current.checkpoint = checkpoint;
  if (preparing && cursor && !current.preparing.includes(cursor)) {
    current.preparing = [...current.preparing, cursor].slice(-SEARCH_WINDOW_LIMIT);
  }
  if (ready && authoritative && enabled && historyEnabled) {
    current.history = admitSearchWindow(
      current.history,
      requestedCursor,
      pending.current?.from ?? current.attemptedFrom,
    );
    current.attemptedFrom = undefined;
    current.preparing = [];
  }
  const admittedPosition = searchWindowPosition(current.history, requestedCursor);
  const position = {
    ...admittedPosition,
    previous:
      admittedPosition.previous ??
      (recoverable && admittedPosition.index < 0 && current.attemptedFrom !== undefined
        ? current.history.windows.find((entry) => entry.cursor === current.attemptedFrom)
        : undefined),
  };

  useLayoutEffect(() => {
    if (!enabled || !settled || !authoritative) return;
    const transition = pending.current;
    if (transition?.request === request && transition.to === cursor) {
      pending.current = undefined;
      setBusy(false);
      focus.current?.settle(request, cursor, navigationRef.current, regionRef.current);
    } else if (!transition) setBusy(false);
    if (!ready || !historyEnabled || typeof window === 'undefined') return;
    // Preserve the router's own entry key and scroll state. No navigation or request is dispatched here.
    window.history.replaceState(
      {
        ...window.history.state,
        [SEARCH_WINDOW_STATE]: { request, checkpoint: current.checkpoint, history: current.history },
      },
      '',
    );
  }, [request, cursor, ready, settled, enabled, authoritative, checkpoint, current.history]);

  useEffect(() => {
    if (changedOwner) setBusy(false);
  }, [request]);
  useEffect(
    () => () => {
      focus.current?.retire();
      pending.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (!router) return;
    return router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      const locationHref = toLocation.publicHref;
      const target = pending.current;
      const expected = target ? href(target.to ?? undefined) : undefined;
      // Every unactivated navigation, including opening a result, retires focus immediately.
      if (!expected || locationHref.split('#')[0] !== expected) {
        pending.current = undefined;
        focus.current?.retire();
        setBusy(false);
      }
    });
  }, [router, request, cursor, locale]);

  function activate(event: React.MouseEvent<HTMLAnchorElement>, target: string | undefined, action: string) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (!router) return; // The exact address remains a native link before hydration.
    event.preventDefault();
    if (!enabled || pending.current || !address.isCurrent() || !readerCurrent() || !isCurrent()) return;
    if ((target ?? null) === cursor && action !== 'retry' && action !== 'first') return;
    const to = target ?? null;
    focus.current?.capture(request, to, action, event.currentTarget);
    const from = searchWindowPosition(current.history, requestedCursor).current ? cursor : current.attemptedFrom;
    pending.current = { request, from, to, action };
    current.attemptedFrom = from;
    setBusy(true);
    const targetHref = href(target);
    void router.navigate({ href: targetHref }).then(
      () => {
        // Successful results settle in the layout effect. Route errors may resolve without that render.
        if (pending.current?.request !== request || pending.current.to !== to) return;
        if (address.isCurrent() && readerCurrent() && !router.state.matches.some((match) => match.status === 'error'))
          return;
        pending.current = undefined;
        setBusy(false);
        focus.current?.retire();
      },
      () => {
        if (pending.current?.request !== request || pending.current.to !== to) return;
        pending.current = undefined;
        setBusy(false);
        focus.current?.retire();
      },
    );
  }
  return {
    firstHref,
    href,
    history: current.history,
    position,
    busy,
    navigationRef,
    regionRef,
    activate,
    nextAllowed: (next: string | null | undefined) =>
      historyEnabled &&
      !!next &&
      href(next).length <= SEARCH_ADDRESS_LIMIT &&
      ((preparing && next === cursor) ||
        (searchWindowNextAllowed(current.history, requestedCursor, next) &&
          !current.preparing.includes(next) &&
          current.preparing.length < SEARCH_WINDOW_LIMIT)),
  };
}
export type SearchWindowNavigation = ReturnType<typeof useSearchWindow>;
