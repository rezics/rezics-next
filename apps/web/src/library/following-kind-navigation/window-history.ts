import type { FollowingKind } from './address';

export type FollowingWindow = { cursor: string | null; kind: FollowingKind };
export type FollowingMovement = 'next' | 'previous' | 'first' | 'kind';

type FollowingIdentity = {
  source: object;
  subject: string;
  locale: string;
  authorityEpoch: number;
};

type AcceptedWindow = FollowingIdentity & {
  address: FollowingWindow;
  addressVisit: number;
  focusId?: number;
};

type StagedWindow = FollowingIdentity & {
  from: FollowingWindow;
  fromVisit: number;
  target: FollowingWindow;
  targetVisit?: number;
  movement: FollowingMovement;
  id: number;
  keyboard: boolean;
};

export type FollowingWindowHistory = {
  current: AcceptedWindow | null;
  previous: FollowingWindow[];
  staged: StagedWindow | null;
};

export const followingPreviousLimit = 8;

export function emptyFollowingWindowHistory(): FollowingWindowHistory {
  return { current: null, previous: [], staged: null };
}

export function sameFollowingWindow(a: FollowingWindow, b: FollowingWindow): boolean {
  return a.cursor === b.cursor && a.kind === b.kind;
}

export function sameFollowingIdentity(a: FollowingIdentity, b: FollowingIdentity): boolean {
  return (
    a.source === b.source && a.subject === b.subject && a.locale === b.locale && a.authorityEpoch === b.authorityEpoch
  );
}

export function stageFollowingWindow(
  history: FollowingWindowHistory,
  input: {
    from: FollowingWindow;
    addressVisit: number;
    target: FollowingWindow;
    movement: FollowingMovement;
    identity: FollowingIdentity;
    id: number;
    keyboard: boolean;
  },
): FollowingWindowHistory | null {
  const current = history.current;
  if (
    history.staged ||
    !current ||
    !sameFollowingWindow(current.address, input.from) ||
    current.addressVisit !== input.addressVisit ||
    !sameFollowingIdentity(current, input.identity) ||
    (input.movement === 'previous' &&
      (!history.previous.length || !sameFollowingWindow(history.previous.at(-1)!, input.target))) ||
    (input.movement === 'kind' && input.from.kind === input.target.kind) ||
    (input.movement === 'next' && sameFollowingWindow(input.from, input.target))
  )
    return null;
  return {
    ...history,
    staged: {
      ...input.identity,
      from: input.from,
      fromVisit: input.addressVisit,
      target: input.target,
      movement: input.movement,
      id: input.id,
      keyboard: input.keyboard,
    },
  };
}

export function acceptFollowingWindow(
  history: FollowingWindowHistory,
  address: FollowingWindow,
  addressVisit: number,
  identity: FollowingIdentity,
): FollowingWindowHistory {
  const staged = history.staged;
  if (!staged || !sameFollowingWindow(staged.target, address)) return history;
  const current = history.current;
  if (
    !current ||
    !sameFollowingWindow(current.address, staged.from) ||
    current.addressVisit !== staged.fromVisit ||
    !sameFollowingIdentity(current, staged) ||
    staged.subject !== identity.subject ||
    staged.locale !== identity.locale ||
    staged.authorityEpoch !== identity.authorityEpoch
  )
    return { current: { ...identity, address, addressVisit }, previous: [], staged: null };

  const previous =
    staged.movement === 'next'
      ? [...history.previous, staged.from].slice(-followingPreviousLimit)
      : staged.movement === 'previous'
        ? history.previous.slice(0, -1)
        : [];
  return {
    current: { ...identity, address, addressVisit, ...(staged.keyboard ? { focusId: staged.id } : {}) },
    previous,
    staged: null,
  };
}

/** A browser address visit without a staged app movement starts a fresh private path. */
export function reconcileFollowingAddress(
  history: FollowingWindowHistory,
  address: FollowingWindow,
  addressVisit: number,
): FollowingWindowHistory {
  const staged = history.staged;
  if (staged) {
    if (sameFollowingWindow(address, staged.target)) {
      if (staged.targetVisit === addressVisit) return history;
      if (staged.targetVisit === undefined && addressVisit !== staged.fromVisit)
        return { ...history, staged: { ...staged, targetVisit: addressVisit } };
      if (
        staged.targetVisit === undefined &&
        addressVisit === staged.fromVisit &&
        sameFollowingWindow(staged.from, staged.target)
      )
        return history;
      return emptyFollowingWindowHistory();
    }
    return sameFollowingWindow(address, staged.from) && addressVisit === staged.fromVisit
      ? history
      : emptyFollowingWindowHistory();
  }
  return !history.current ||
    (sameFollowingWindow(address, history.current.address) && addressVisit === history.current.addressVisit)
    ? history
    : emptyFollowingWindowHistory();
}

/** Retire source and authority callbacks without retaining an old page body. */
export function reconcileFollowingIdentity(
  history: FollowingWindowHistory,
  address: FollowingWindow,
  identity: FollowingIdentity,
): FollowingWindowHistory {
  const staged = history.staged;
  if (staged && sameFollowingWindow(address, staged.target)) return history;
  if (staged && sameFollowingWindow(address, staged.from))
    return sameFollowingIdentity(staged, identity) ? history : emptyFollowingWindowHistory();
  const current = history.current;
  return current && sameFollowingWindow(address, current.address) && sameFollowingIdentity(current, identity)
    ? history
    : emptyFollowingWindowHistory();
}

export function reconcileFollowingAuthority(
  history: FollowingWindowHistory,
  subject: string | null,
  locale: string,
  authorityEpoch: number,
): FollowingWindowHistory {
  const current = history.current;
  const staged = history.staged;
  if (
    !subject ||
    (current &&
      (current.subject !== subject || current.locale !== locale || current.authorityEpoch !== authorityEpoch)) ||
    (staged && (staged.subject !== subject || staged.locale !== locale || staged.authorityEpoch !== authorityEpoch))
  )
    return emptyFollowingWindowHistory();
  return history;
}

export function seedFollowingWindow(
  history: FollowingWindowHistory,
  address: FollowingWindow,
  addressVisit: number,
  identity: FollowingIdentity,
): FollowingWindowHistory {
  if (history.staged || history.current) return history;
  return { current: { ...identity, address, addressVisit }, previous: [], staged: null };
}

export function retireFollowingAuthority(
  history: FollowingWindowHistory,
  subject: string | null,
): FollowingWindowHistory {
  const current = history.current;
  const staged = history.staged;
  if (!subject || (current && current.subject !== subject) || (staged && staged.subject !== subject))
    return emptyFollowingWindowHistory();
  return history;
}
