import type { MemberAddress } from './source';

export const MAX_PREDECESSORS = 8;

export type WindowDirection = 'initial' | 'more' | 'previous' | 'first';
export type StagedWindowMove = {
  direction: WindowDirection;
  target: MemberAddress;
  authority: string | null;
};
export type WindowNavigation = {
  current: MemberAddress | null;
  predecessors: readonly MemberAddress[];
  staged: StagedWindowMove | null;
};

export function emptyWindowNavigation(): WindowNavigation {
  return { current: null, predecessors: [], staged: null };
}

export function sameCoordinate(left: MemberAddress | null, right: MemberAddress | null) {
  return left?.realmId === right?.realmId && left?.cursor === right?.cursor;
}

export function stageWindowMove(
  navigation: WindowNavigation,
  direction: WindowDirection,
  target: MemberAddress,
  authority: string | null,
): StagedWindowMove {
  const staged = { direction, target, authority };
  navigation.staged = staged;
  return staged;
}

export function acceptWindowMove(navigation: WindowNavigation, move: StagedWindowMove): WindowNavigation {
  if (navigation.staged !== move) return navigation;

  let predecessors = navigation.predecessors;
  if (move.direction === 'more' && navigation.current) {
    predecessors = [...predecessors, navigation.current].slice(-MAX_PREDECESSORS);
  } else if (move.direction === 'previous') {
    predecessors = predecessors.slice(0, -1);
  } else if (move.direction === 'first' || move.direction === 'initial') {
    predecessors = [];
  }

  return { current: move.target, predecessors, staged: null };
}

export function clearStagedMove(navigation: WindowNavigation, move: StagedWindowMove): WindowNavigation {
  if (navigation.staged !== move) return navigation;
  return { ...navigation, staged: null };
}
