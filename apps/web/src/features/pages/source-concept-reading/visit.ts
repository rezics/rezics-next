import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import type { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { appendChangePage, firstChangePage, type ChangePageHistory } from '../../catalogue/subject-changes-navigation';
import { conceptSourceFits, validConceptCursor, type ConceptRead } from '../../catalogue/source-concept-explorer';

export type ConceptPage = Extract<ConceptRead, { ok: true }>;
export type ConceptInput = { cursor?: string | undefined; session?: string | undefined };
export type ConceptTransport = { read: (input: ConceptInput) => Promise<ConceptRead> };
type Position = { history: ChangePageHistory; index: number };
type Destination = { input: ConceptInput; mode: 'next' | 'previous' | 'refresh'; index?: number };
export type FailedPage = Destination & { state: 'preparing' | 'unavailable' };
type VisitState = Position & {
  read?: ConceptPage;
  retained?: ConceptPage;
  error?: CandidateFailure;
  failed?: FailedPage;
  loading: boolean;
  busy: boolean;
  completed: number;
};
type Admission = ReturnType<typeof useCatalogueLifetime>;

/** Retained rows belong to exactly this native revision and session receipt. */
function samePageSource(left: ConceptPage | undefined, right: ConceptPage) {
  return (
    !!left &&
    left.admitted &&
    right.admitted &&
    left.public.subject.id === right.public.subject.id &&
    left.public.subject.release === right.public.subject.release &&
    left.public.subject.revision === right.public.subject.revision &&
    left.public.subject.context === right.public.subject.context &&
    left.public.subject.type === right.public.subject.type &&
    left.requestedRole === right.requestedRole &&
    left.session === right.session
  );
}

function usablePage(page: ConceptPage | undefined) {
  return page?.admitted && (page.narrower.state === 'available' || page.narrower.state === 'lagging')
    ? page
    : undefined;
}

function position(state: VisitState, page: ConceptPage, destination: Destination): Position {
  const { cursor } = destination.input;
  if (!samePageSource(state.read, page)) return { history: { addresses: [cursor], truncated: false }, index: 0 };
  if (destination.mode === 'previous' && destination.index !== undefined)
    return { history: state.history, index: destination.index };
  if (destination.mode === 'next' && cursor) {
    const existing = state.history.addresses[state.index + 1] === cursor;
    const history = existing
      ? state.history
      : appendChangePage(
          {
            ...state.history,
            addresses: state.history.addresses.slice(0, state.index + 1),
          },
          cursor,
        );
    return { history, index: history.addresses.indexOf(cursor) };
  }
  return { history: state.history, index: state.index };
}

function publish(
  state: VisitState,
  result: ConceptRead,
  destination: Destination,
  id: string,
  role: string | undefined,
): VisitState {
  // Validate before any path can publish private advice, rows, continuation or focus.
  if (
    result.ok &&
    (result.public.subject.id !== id ||
      result.requestedRole !== role ||
      result.narrower.cursor !== destination.input.cursor)
  )
    result = candidateFailure(400);
  if (result.ok && (!conceptSourceFits(result.public) || result.narrower.rows.length > 20))
    result = { ok: false, reason: 'unavailable', oversized: true };
  const done = { loading: false, busy: false, completed: state.completed + 1 };
  if (!result.ok)
    return {
      ...done,
      history: firstChangePage(),
      index: 0,
      error: result,
      failed: { ...destination, state: 'unavailable' },
    };
  if (result.admitted && (result.narrower.state === 'preparing' || result.narrower.state === 'unavailable')) {
    const previous = usablePage(state.read) ?? state.retained;
    const retained = samePageSource(previous, result) ? previous : undefined;
    return {
      ...done,
      read: result,
      ...(retained ? { retained } : {}),
      history: retained ? state.history : { addresses: [destination.input.cursor], truncated: false },
      index: retained ? state.index : 0,
      failed: { ...destination, state: result.narrower.state },
    };
  }
  return { ...done, read: result, ...position(state, result, destination) };
}

/** One concept visit under the existing catalogue admission; no cache can resurrect a retired visit. */
export function useConceptVisit({
  id,
  role,
  transport,
  initial,
  admission,
}: {
  id: string;
  role: string | undefined;
  transport: ConceptTransport;
  initial: ConceptRead | undefined;
  admission: Admission;
}) {
  const seed: VisitState = {
    history: firstChangePage(),
    index: 0,
    loading: initial === undefined,
    busy: false,
    completed: 0,
  };
  const [state, setState] = useState(() =>
    initial === undefined
      ? seed
      : publish(
          seed,
          initial,
          {
            input: {},
            mode: 'refresh',
          },
          id,
          role,
        ),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const sequence = useRef(0);
  const mounted = useRef(false);
  const busy = useRef(false);
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focus = useRef<{ trigger: Element | null; moved: boolean } | undefined>(undefined);
  const stopFocus = useRef<(() => void) | undefined>(undefined);

  useLayoutEffect(() => {
    if (state.busy || state.loading) return;
    const pending = focus.current;
    focus.current = undefined;
    stopFocus.current?.();
    stopFocus.current = undefined;
    if (!pending || pending.moved || !admission.active()) return;
    const active = document.activeElement;
    if (active === pending.trigger || active === document.body) statusRef.current?.focus();
  }, [state.completed, admission]);

  async function run(destination: Destination, explicit: boolean, expected?: VisitState) {
    if (expected && stateRef.current !== expected) return;
    if (busy.current || !mounted.current || !admission.active() || !validConceptCursor(destination.input.cursor))
      return;
    busy.current = true;
    const request = ++sequence.current;
    const source = stateRef.current;
    if (explicit) {
      const pending = { trigger: document.activeElement, moved: false };
      focus.current = pending;
      const moved = (event: Event) => {
        if (event.type !== 'focusin' || event.target !== pending.trigger) pending.moved = true;
      };
      for (const name of ['focusin', 'pointerdown', 'keydown']) document.addEventListener(name, moved);
      stopFocus.current = () => {
        for (const name of ['focusin', 'pointerdown', 'keydown']) document.removeEventListener(name, moved);
      };
    }
    setState((current) => ({ ...current, busy: true }));
    let result: ConceptRead;
    try {
      result = await transportRef.current.read(destination.input);
    } catch {
      result = candidateFailure(503);
    }
    if (!mounted.current || !admission.active() || sequence.current !== request) return;
    busy.current = false;
    const published = publish(source, result, destination, id, role);
    stateRef.current = published;
    setState(published);
  }

  useEffect(() => {
    mounted.current = true;
    if (initial === undefined) void run({ input: {}, mode: 'refresh' }, false);
    return () => {
      mounted.current = false;
      sequence.current++;
      busy.current = false;
      stopFocus.current?.();
    };
  }, []);

  const hierarchy = state.retained?.narrower ?? state.read?.narrower;
  return {
    ...state,
    hierarchy,
    statusRef,
    previous: () =>
      state.index > 0 &&
      run(
        {
          input: { cursor: state.history.addresses[state.index - 1], session: state.read?.session },
          mode: 'previous',
          index: state.index - 1,
        },
        true,
        state,
      ),
    next: () =>
      hierarchy?.next &&
      !state.failed &&
      run(
        {
          input: { cursor: hierarchy.next, session: state.read?.session },
          mode: 'next',
        },
        true,
        state,
      ),
    retry: () => state.failed && run(state.failed, true, state),
    refresh: () =>
      state.failed
        ? run(state.failed, true, state)
        : run(
            {
              input: { cursor: state.read?.narrower.cursor, session: state.read?.session },
              mode: 'refresh',
            },
            true,
            state,
          ),
  };
}
export type ConceptVisit = ReturnType<typeof useConceptVisit>;
