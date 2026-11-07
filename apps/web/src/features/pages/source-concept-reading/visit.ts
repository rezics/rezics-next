import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import type { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { firstChangePage, type ChangePageHistory } from '../../catalogue/subject-changes-navigation';
import {
  conceptPageCap,
  conceptSourceFits,
  membershipPageCap,
  membershipProperties,
  validConceptCursor,
  validMembershipCursor,
  type ConceptMembershipCursors,
  type ConceptRead,
  type MembershipProperty,
} from '../../catalogue/source-concept-explorer';
import {
  conceptHierarchyAddressFor,
  conceptVisitHistoryLimit,
  currentnessMatches,
  encodeConceptHierarchyAddress,
  type ConceptFocus,
  type ConceptHierarchyAddress,
} from './navigation';

export type ConceptPage = Extract<ConceptRead, { ok: true }>;
export type ConceptInput = {
  cursor?: string | undefined;
  membership?: ConceptMembershipCursors | undefined;
  session?: string | undefined;
};
export type ConceptTransport = { read: (input: ConceptInput) => Promise<ConceptRead> };
type Position = { history: ChangePageHistory; index: number };
type MembershipPosition = {
  membershipHistory: Record<MembershipProperty, ChangePageHistory>;
  membershipIndex: Record<MembershipProperty, number>;
};
type Destination = {
  input: ConceptInput;
  mode: 'next' | 'previous' | 'refresh' | 'restore' | 'restart' | 'membership-next' | 'membership-previous';
  index?: number;
  property?: MembershipProperty;
  address?: ConceptHierarchyAddress;
};
export type FailedPage = Destination & { state: 'preparing' | 'unavailable' };
type VisitState = Position &
  MembershipPosition & {
    read?: ConceptPage;
    retained?: ConceptPage;
    error?: CandidateFailure;
    failed?: FailedPage;
    loading: boolean;
    busy: boolean;
    completed: number;
    focus?: ConceptFocus;
    notice?: 'currentness' | 'row-missing';
    noticeSection?: ConceptFocus['section'];
  };
type Admission = ReturnType<typeof useCatalogueLifetime>;

function firstMembershipPages(): MembershipPosition {
  return {
    membershipHistory: {
      'schema:genre': firstChangePage(),
      'schema:keywords': firstChangePage(),
    },
    membershipIndex: { 'schema:genre': 0, 'schema:keywords': 0 },
  };
}

function appendConceptPage(history: ChangePageHistory, cursor: string): ChangePageHistory {
  if (!cursor || new TextEncoder().encode(cursor).byteLength > 4096 || history.addresses.at(-1) === cursor)
    return history;
  const addresses = [...history.addresses, cursor];
  const truncated = history.truncated || addresses.length > conceptVisitHistoryLimit;
  if (addresses.length > conceptVisitHistoryLimit) addresses.shift();
  return { addresses, truncated };
}

function membershipCursorsOf(state: MembershipPosition): ConceptMembershipCursors {
  const cursors: ConceptMembershipCursors = {};
  for (const property of membershipProperties) {
    const cursor = state.membershipHistory[property].addresses[state.membershipIndex[property]];
    if (cursor) cursors[property] = cursor;
  }
  return cursors;
}

function visitInput(state: VisitState, patch: ConceptInput): ConceptInput {
  const membership = { ...membershipCursorsOf(state), ...patch.membership };
  const defined = Object.fromEntries(
    Object.entries(membership).filter((entry) => typeof entry[1] === 'string'),
  ) as ConceptMembershipCursors;
  const input: ConceptInput = { ...patch };
  if (!input.cursor) delete input.cursor;
  if (!input.session) delete input.session;
  if (Object.keys(defined).length) input.membership = defined;
  else delete input.membership;
  return input;
}

function membershipOversized(page: ConceptPage) {
  return membershipProperties.some((property) => page.membership.streams[property].rows.length > membershipPageCap);
}

function requestedMembershipMatches(page: ConceptPage, requested: ConceptMembershipCursors | undefined) {
  return membershipProperties.every(
    (property) => page.membership.streams[property].cursor === (requested?.[property] || undefined),
  );
}

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
  if (destination.mode === 'restart') return { history: firstChangePage(), index: 0 };
  if (destination.mode === 'restore' && destination.address && samePageSource(state.read, page)) {
    return {
      history: {
        addresses: destination.address.addresses.map((address) => address ?? undefined),
        truncated: destination.address.truncated,
      },
      index: destination.address.index,
    };
  }
  if (!samePageSource(state.read, page)) return { history: { addresses: [cursor], truncated: false }, index: 0 };
  if (destination.mode === 'membership-next' || destination.mode === 'membership-previous')
    return { history: state.history, index: state.index };
  if (destination.mode === 'previous' && destination.index !== undefined)
    return { history: state.history, index: destination.index };
  if (destination.mode === 'next' && cursor) {
    const existing = state.history.addresses[state.index + 1] === cursor;
    const history = existing
      ? state.history
      : appendConceptPage(
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

function membershipPosition(state: VisitState, page: ConceptPage, destination: Destination): MembershipPosition {
  if (destination.mode === 'restart' || !samePageSource(state.read, page)) return firstMembershipPages();
  if (destination.mode !== 'membership-next' && destination.mode !== 'membership-previous') {
    return { membershipHistory: state.membershipHistory, membershipIndex: state.membershipIndex };
  }
  const property = destination.property;
  if (!property) return { membershipHistory: state.membershipHistory, membershipIndex: state.membershipIndex };
  const cursor = destination.input.membership?.[property];
  if (destination.mode === 'membership-previous' && destination.index !== undefined) {
    return {
      membershipHistory: state.membershipHistory,
      membershipIndex: { ...state.membershipIndex, [property]: destination.index },
    };
  }
  if (destination.mode === 'membership-next' && cursor) {
    const current = state.membershipHistory[property];
    const existing = current.addresses[state.membershipIndex[property] + 1] === cursor;
    const history = existing
      ? current
      : appendConceptPage(
          { ...current, addresses: current.addresses.slice(0, state.membershipIndex[property] + 1) },
          cursor,
        );
    return {
      membershipHistory: { ...state.membershipHistory, [property]: history },
      membershipIndex: { ...state.membershipIndex, [property]: history.addresses.indexOf(cursor) },
    };
  }
  return { membershipHistory: state.membershipHistory, membershipIndex: state.membershipIndex };
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
      result.narrower.cursor !== destination.input.cursor ||
      !requestedMembershipMatches(result, destination.input.membership))
  )
    result = candidateFailure(400);
  if (
    result.ok &&
    (!conceptSourceFits(result.public) || result.narrower.rows.length > conceptPageCap || membershipOversized(result))
  )
    result = { ok: false, reason: 'unavailable', oversized: true };
  const done = { loading: false, busy: false, completed: state.completed + 1 };
  if (!result.ok)
    return {
      ...done,
      ...firstMembershipPages(),
      history: firstChangePage(),
      index: 0,
      error: result,
      failed: { ...destination, state: 'unavailable' },
    };
  if (destination.mode === 'restore' && !samePageSource(state.read, result))
    return {
      ...done,
      ...firstMembershipPages(),
      read: result,
      history: firstChangePage(),
      index: 0,
      notice: 'currentness',
      noticeSection: destination.address?.focus?.section ?? 'hierarchy',
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
      ...(retained
        ? { membershipHistory: state.membershipHistory, membershipIndex: state.membershipIndex }
        : firstMembershipPages()),
      failed: { ...destination, state: result.narrower.state },
    };
  }
  const published: VisitState = {
    ...done,
    read: result,
    ...position(state, result, destination),
    ...membershipPosition(state, result, destination),
    ...(destination.mode === 'restore' && destination.address?.focus ? { focus: destination.address.focus } : {}),
    ...(destination.mode === 'refresh' && state.notice ? { notice: state.notice } : {}),
    ...(destination.mode === 'refresh' && state.noticeSection ? { noticeSection: state.noticeSection } : {}),
  };
  return published;
}

function addressKey(address: ConceptHierarchyAddress | undefined) {
  return address ? (encodeConceptHierarchyAddress(address) ?? 'invalid') : '';
}

/** One concept visit under the existing catalogue admission; no cache can resurrect a retired visit. */
export function useConceptVisit({
  id,
  role,
  transport,
  initial,
  admission,
  address,
  onAddressChange,
}: {
  id: string;
  role: string | undefined;
  transport: ConceptTransport;
  initial: ConceptRead | undefined;
  admission: Admission;
  address?: ConceptHierarchyAddress | undefined;
  onAddressChange?:
    | ((address: ConceptHierarchyAddress | undefined, options?: { replace?: boolean }) => void)
    | undefined;
}) {
  const seed: VisitState = {
    history: firstChangePage(),
    index: 0,
    ...firstMembershipPages(),
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
  const routeAddressKey = useRef('');
  const expectedAddressKey = useRef<string | undefined>(undefined);
  const pendingRestore = useRef<
    { address: ConceptHierarchyAddress | undefined; afterRequest: number; waitingForFreshRead: boolean } | undefined
  >(undefined);

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
    if (
      busy.current ||
      !mounted.current ||
      !admission.active() ||
      !validConceptCursor(destination.input.cursor) ||
      membershipProperties.some(
        (property) =>
          destination.input.membership?.[property] !== undefined &&
          !validMembershipCursor(destination.input.membership[property]),
      )
    )
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
    const pending = pendingRestore.current;
    if (pending?.waitingForFreshRead) {
      if (destination.mode === 'refresh' && request > pending.afterRequest) {
        pendingRestore.current = { ...pending, waitingForFreshRead: false };
      } else {
        void run({ input: {}, mode: 'refresh' }, false, published);
        return;
      }
    }
    if (published.read && !published.error && !published.failed) {
      if (destination.mode === 'next' || destination.mode === 'previous' || destination.mode === 'restart') {
        const nextAddress = conceptHierarchyAddressFor(published.read, published.history, published.index);
        const key = addressKey(nextAddress);
        expectedAddressKey.current = key;
        onAddressChange?.(nextAddress, { replace: destination.mode === 'restart' });
      }
    }
  }

  useEffect(() => {
    const key = addressKey(address);
    if (key === routeAddressKey.current) return;
    routeAddressKey.current = key;
    if (expectedAddressKey.current === key) {
      expectedAddressKey.current = undefined;
      return;
    }
    pendingRestore.current = { address, afterRequest: sequence.current, waitingForFreshRead: true };
    if (mounted.current && !stateRef.current.loading && !stateRef.current.busy)
      void run({ input: {}, mode: 'refresh' }, false);
  }, [address]);

  useEffect(() => {
    mounted.current = true;
    if (initial === undefined || pendingRestore.current) void run({ input: {}, mode: 'refresh' }, false);
    return () => {
      mounted.current = false;
      sequence.current++;
      busy.current = false;
      stopFocus.current?.();
    };
  }, []);

  useEffect(() => {
    const pending = pendingRestore.current;
    if (!pending || pending.waitingForFreshRead || state.loading || state.busy || !state.read || !admission.active())
      return;
    pendingRestore.current = undefined;
    const wanted = pending.address;
    if (!wanted) {
      const reset: VisitState = {
        ...state,
        history: firstChangePage(),
        index: 0,
      };
      delete reset.focus;
      delete reset.notice;
      delete reset.noticeSection;
      stateRef.current = reset;
      setState(reset);
      return;
    }
    if (!currentnessMatches(state.read, wanted)) {
      const changed: VisitState = {
        ...state,
        history: firstChangePage(),
        index: 0,
        notice: 'currentness' as const,
        noticeSection: wanted.focus?.section ?? 'hierarchy',
      };
      delete changed.focus;
      stateRef.current = changed;
      setState(changed);
      expectedAddressKey.current = '';
      onAddressChange?.(undefined, { replace: true });
      return;
    }
    const cursor = wanted.addresses[wanted.index] ?? undefined;
    if (cursor && state.read.narrower.cursor !== cursor) {
      void run(
        {
          input: visitInput(state, { cursor, session: state.read.session }),
          mode: 'restore',
          address: wanted,
        },
        false,
        state,
      );
      return;
    }
    const restored: VisitState = {
      ...state,
      history: { addresses: wanted.addresses.map((item) => item ?? undefined), truncated: wanted.truncated },
      index: wanted.index,
    };
    delete restored.focus;
    delete restored.notice;
    delete restored.noticeSection;
    if (wanted.focus) restored.focus = wanted.focus;
    stateRef.current = restored;
    setState(restored);
  }, [state.completed, state.loading, state.busy, state.read, admission]);

  const hierarchy = state.retained?.narrower ?? state.read?.narrower;
  return {
    ...state,
    hierarchy,
    statusRef,
    previous: () =>
      state.index > 0 &&
      run(
        {
          input: visitInput(state, {
            cursor: state.history.addresses[state.index - 1],
            session: state.read?.session,
          }),
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
          input: visitInput(state, { cursor: hierarchy.next, session: state.read?.session }),
          mode: 'next',
        },
        true,
        state,
      ),
    membershipPrevious: (property: MembershipProperty) =>
      state.membershipIndex[property] > 0 &&
      run(
        {
          input: visitInput(state, {
            cursor: state.read?.narrower.cursor,
            membership: {
              [property]: state.membershipHistory[property].addresses[state.membershipIndex[property] - 1],
            },
            session: state.read?.session,
          }),
          mode: 'membership-previous',
          property,
          index: state.membershipIndex[property] - 1,
        },
        true,
        state,
      ),
    membershipNext: (property: MembershipProperty) => {
      const next = state.read?.membership.streams[property].next;
      return (
        next &&
        run(
          {
            input: visitInput(state, {
              cursor: state.read?.narrower.cursor,
              membership: { [property]: next },
              session: state.read?.session,
            }),
            mode: 'membership-next',
            property,
          },
          true,
          state,
        )
      );
    },
    membershipIndexFor: (property: MembershipProperty) => state.membershipIndex[property],
    retry: () => state.failed && run(state.failed, true, state),
    restart: () => run({ input: {}, mode: 'restart' }, true, state),
    reportFocusMissing: () => {
      if (!state.focus || !admission.active()) return;
      const missing: VisitState = {
        ...state,
        notice: 'row-missing' as const,
        noticeSection: state.focus.section,
      };
      delete missing.focus;
      stateRef.current = missing;
      setState(missing);
      const position = conceptHierarchyAddressFor(missing.read!, missing.history, missing.index, undefined);
      const key = addressKey(position);
      expectedAddressKey.current = key;
      onAddressChange?.(position, { replace: true });
    },
    refresh: () =>
      state.failed
        ? run(state.failed, true, state)
        : run(
            {
              input: visitInput(state, {
                cursor: state.read?.narrower.cursor,
                session: state.read?.session,
              }),
              mode: 'refresh',
            },
            true,
            state,
          ),
  };
}
export type ConceptVisit = ReturnType<typeof useConceptVisit>;
