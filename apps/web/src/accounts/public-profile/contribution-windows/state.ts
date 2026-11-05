export type ContributionWindowView = 'posts' | 'reviews' | 'discussion';
export type ContributionCoordinate = string | null;
export type ContributionWindowOwner = {
  accountId: string;
  view: ContributionWindowView;
  locale: string;
  published: boolean;
};
export type ContributionWindowAction = 'next' | 'previous' | 'first' | 'retry';
export type ContributionWindowOutcome = 'admitted' | 'failed' | 'pending';

const predecessorLimit = 8;
const cursorLimit = 4096;

type Move = {
  from: ContributionCoordinate;
  target: ContributionCoordinate;
  action: ContributionWindowAction;
  href: string;
  failed: boolean;
};

type FocusIntent = {
  href: string;
  action: Exclude<ContributionWindowAction, 'retry'>;
  target: ContributionCoordinate;
  source: HTMLElement;
  cancelled: boolean;
  onFocus: (event: FocusEvent) => void;
};

type Visit = {
  owner: ContributionWindowOwner;
  predecessors: ContributionCoordinate[];
  current: ContributionCoordinate;
  pending: Move | null;
  focus: FocusIntent | null;
};

export type ContributionWindowSnapshot = {
  predecessors: readonly ContributionCoordinate[];
  current: ContributionCoordinate;
  pending: Readonly<Move> | null;
  focusReady: boolean;
};

const liveVisits = new WeakMap<Window, Visit>();

function sameOwner(left: ContributionWindowOwner, right: ContributionWindowOwner): boolean {
  return (
    left.accountId === right.accountId &&
    left.view === right.view &&
    left.locale === right.locale &&
    left.published === right.published
  );
}

function releaseFocus(visit: Visit): void {
  const focus = visit.focus;
  if (!focus) return;
  focus.source.ownerDocument.removeEventListener('focusin', focus.onFocus, true);
  visit.focus = null;
}

function retireVisit(host: Window, visit: Visit): void {
  releaseFocus(visit);
  if (liveVisits.get(host) === visit) liveVisits.delete(host);
}

function createVisit(owner: ContributionWindowOwner, cursor: ContributionCoordinate): Visit {
  return { owner: { ...owner }, predecessors: [], current: cursor, pending: null, focus: null };
}

function setFocus(
  visit: Visit,
  href: string,
  action: Exclude<ContributionWindowAction, 'retry'>,
  target: ContributionCoordinate,
  source: HTMLElement,
): void {
  releaseFocus(visit);
  const focus: FocusIntent = {
    href,
    action,
    target,
    source,
    cancelled: false,
    onFocus: (_event: FocusEvent) => {},
  };
  focus.onFocus = (event) => {
    const node = event.target;
    if (node === source || node === source.ownerDocument.body || node === source.ownerDocument.documentElement) return;
    focus.cancelled = true;
    releaseFocus(visit);
  };
  visit.focus = focus;
  source.ownerDocument.addEventListener('focusin', focus.onFocus, true);
}

function beginMove(
  visit: Visit,
  input: {
    target: ContributionCoordinate;
    action: ContributionWindowAction;
    href: string;
    keyboard: boolean;
    source?: HTMLElement;
  },
): void {
  releaseFocus(visit);
  visit.pending = {
    from: visit.current,
    target: input.target,
    action: input.action,
    href: input.href,
    failed: false,
  };
  if (input.keyboard && input.source && input.action !== 'retry')
    setFocus(visit, input.href, input.action, input.target, input.source);
}

function visitFor(
  host: Window,
  owner: ContributionWindowOwner,
  cursor: ContributionCoordinate,
  href: string,
): Visit | undefined {
  if (!owner.published) {
    const existing = liveVisits.get(host);
    if (existing) retireVisit(host, existing);
    return;
  }
  let visit = liveVisits.get(host);
  if (!visit || !sameOwner(visit.owner, owner)) {
    if (visit) retireVisit(host, visit);
    visit = createVisit(owner, cursor);
    liveVisits.set(host, visit);
    return visit;
  }

  if (visit.pending?.target === cursor && visit.pending.href !== href) {
    // The target cursor arrived through another address; it is a fresh direct visit, not this movement.
    retireVisit(host, visit);
    visit = createVisit(owner, cursor);
    liveVisits.set(host, visit);
    return visit;
  }
  if (visit.pending?.target === cursor) return visit;
  if (visit.current === cursor) return visit;

  // A cursor not admitted by this live visit starts with no guessed predecessors.
  retireVisit(host, visit);
  visit = createVisit(owner, cursor);
  liveVisits.set(host, visit);
  return visit;
}

function commitMove(visit: Visit, move: Move): void {
  if (move.action === 'next') {
    if (move.from !== move.target) {
      visit.predecessors.push(visit.current);
      if (visit.predecessors.length > predecessorLimit) visit.predecessors.shift();
    }
    visit.current = move.target;
  } else if (move.action === 'previous') {
    const index = visit.predecessors.lastIndexOf(move.target);
    if (index >= 0) {
      visit.predecessors = visit.predecessors.slice(0, index);
      visit.current = move.target;
    }
  } else if (move.action === 'first') {
    visit.predecessors = [];
    visit.current = null;
  }
}

export function contributionWindowSnapshot(input: {
  owner: ContributionWindowOwner;
  cursor: ContributionCoordinate;
  href: string;
  outcome?: ContributionWindowOutcome;
  host?: Window;
}): ContributionWindowSnapshot {
  const host = input.host ?? (typeof window === 'undefined' ? undefined : window);
  if (!host) return { predecessors: [], current: input.cursor, pending: null, focusReady: false };
  const visit = visitFor(host, input.owner, input.cursor, input.href);
  if (!visit) return { predecessors: [], current: input.cursor, pending: null, focusReady: false };

  const move = visit.pending;
  if (move && move.target === input.cursor && move.href === input.href) {
    if (input.outcome === 'admitted') {
      commitMove(visit, move);
      visit.pending = null;
      if (visit.focus && !visit.focus.cancelled && visit.focus.href === input.href)
        visit.focus.target = input.cursor;
      else releaseFocus(visit);
    } else if (input.outcome === 'failed') {
      move.failed = true;
      releaseFocus(visit);
    }
  }

  return {
    predecessors: [...visit.predecessors],
    current: visit.current,
    pending: visit.pending ? { ...visit.pending } : null,
    focusReady:
      visit.focus !== null &&
      !visit.focus.cancelled &&
      visit.focus.href === input.href &&
      visit.current === visit.focus.target,
  };
}

export function beginContributionWindowMove(input: {
  owner: ContributionWindowOwner;
  cursor: ContributionCoordinate;
  currentHref: string;
  target: ContributionCoordinate;
  targetHref: string;
  action: Exclude<ContributionWindowAction, 'retry'>;
  event: Pick<MouseEvent, 'detail'>;
  source: HTMLElement;
  host?: Window;
}): void {
  const host = input.host ?? (typeof window === 'undefined' ? undefined : window);
  if (!host) return;
  const visit = visitFor(host, input.owner, input.cursor, input.currentHref);
  if (!visit) return;
  beginMove(visit, {
    target: input.target,
    action: input.action,
    href: input.targetHref,
    keyboard: input.event.detail === 0,
    source: input.source,
  });
}

export function retryContributionWindow(input: {
  owner: ContributionWindowOwner;
  cursor: ContributionCoordinate;
  href: string;
  host?: Window;
}): void {
  const host = input.host ?? (typeof window === 'undefined' ? undefined : window);
  if (!host) return;
  const visit = visitFor(host, input.owner, input.cursor, input.href);
  if (!visit) return;
  const pending = visit.pending;
  if (pending && pending.target === input.cursor && pending.href === input.href) {
    pending.failed = false;
    releaseFocus(visit);
    return;
  }
  beginMove(visit, {
    target: input.cursor,
    action: 'retry',
    href: input.href,
    keyboard: false,
  });
}

export function consumeContributionWindowFocus(input: {
  owner: ContributionWindowOwner;
  cursor: ContributionCoordinate;
  href: string;
  region: HTMLElement | null;
  host?: Window;
}): boolean {
  const host = input.host ?? (typeof window === 'undefined' ? undefined : window);
  if (!host) return false;
  const visit = liveVisits.get(host);
  const focus = visit?.focus;
  if (
    !visit ||
    !sameOwner(visit.owner, input.owner) ||
    !focus ||
    focus.cancelled ||
    focus.href !== input.href ||
    focus.target !== input.cursor ||
    visit.current !== input.cursor
  )
    return false;

  const active = host.document.activeElement;
  if (
    active === focus.source &&
    focus.source.isConnected &&
    focus.source.dataset.windowAction === focus.action
  ) {
    releaseFocus(visit);
    return true;
  }
  if (active !== host.document.body && active !== host.document.documentElement) {
    releaseFocus(visit);
    return false;
  }
  const region = input.region;
  releaseFocus(visit);
  if (!region?.isConnected) return false;
  region.focus({ preventScroll: true });
  return true;
}

/** Carry only an in-flight coordinate through a canonical handle redirect for the same resolved account. */
export function forwardContributionWindow(input: {
  owner: ContributionWindowOwner;
  cursor: ContributionCoordinate;
  fromHref: string;
  toHref: string;
  host?: Window;
}): void {
  const host = input.host ?? (typeof window === 'undefined' ? undefined : window);
  if (!host) return;
  const visit = liveVisits.get(host);
  const pending = visit?.pending;
  if (
    !visit ||
    !sameOwner(visit.owner, input.owner) ||
    !pending ||
    pending.target !== input.cursor ||
    pending.href !== input.fromHref
  )
    return;
  pending.href = input.toHref;
  const focus = visit.focus;
  if (focus && !focus.cancelled && focus.target === input.cursor && focus.href === input.fromHref)
    focus.href = input.toHref;
}

export function retireContributionWindow(host: Window = window): void {
  const visit = liveVisits.get(host);
  if (visit) retireVisit(host, visit);
}

export function contributionCoordinateIsBounded(cursor: unknown): cursor is string {
  return typeof cursor === 'string' && cursor.length > 0 && cursor.length <= cursorLimit;
}
