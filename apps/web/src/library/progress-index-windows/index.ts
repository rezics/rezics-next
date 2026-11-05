import { progressAddressIssue, type ProgressIndexAddress } from '../progress-address';

export const PROGRESS_INDEX_WINDOW_PREDECESSORS = 8;
export const progressIndexWindowQueryKey = (visit: string) => ['library', 'progress', 'index-windows', visit] as const;

export type ProgressIndexCoordinate = string | null;
export type ProgressIndexWindowCoordinates = {
  predecessors: ProgressIndexCoordinate[];
  current: ProgressIndexCoordinate;
};
export type ProgressIndexWindowMove = 'previous' | 'first' | 'more' | 'refresh';
export type ProgressIndexWindowTarget = {
  id: string;
  kind: ProgressIndexWindowMove;
  from: ProgressIndexCoordinate;
  to: ProgressIndexCoordinate;
  sourceLocation: string;
  sourceRead: string;
  keyboard: boolean;
};
export type ProgressIndexWindowState = {
  predecessors: ProgressIndexCoordinate[];
  current: ProgressIndexCoordinate | undefined;
  identity: string;
  staged?: ProgressIndexWindowTarget;
  lastMovement?: string;
};
export type ProgressIndexWindowRouteState = {
  visit: string;
  move: string;
  from: ProgressIndexCoordinate;
  to: ProgressIndexCoordinate;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isProgressIndexCoordinate(value: unknown): value is ProgressIndexCoordinate {
  return value === null || (typeof value === 'string' && !progressAddressIssue({ cursor: value }));
}

export function progressIndexWindowCoordinates(value: unknown): ProgressIndexWindowCoordinates | undefined {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.predecessors) || raw.predecessors.length > PROGRESS_INDEX_WINDOW_PREDECESSORS) return;
  if (!raw.predecessors.every(isProgressIndexCoordinate) || !isProgressIndexCoordinate(raw.current)) return;
  return { predecessors: [...raw.predecessors], current: raw.current };
}

export function progressIndexWindowRouteState(value: unknown): ProgressIndexWindowRouteState | undefined {
  const raw = record(record(value)?.progressIndexWindow);
  if (
    !raw ||
    typeof raw.visit !== 'string' ||
    !uuid.test(raw.visit) ||
    typeof raw.move !== 'string' ||
    !uuid.test(raw.move) ||
    !isProgressIndexCoordinate(raw.from) ||
    !isProgressIndexCoordinate(raw.to)
  )
    return;
  return { visit: raw.visit, move: raw.move, from: raw.from, to: raw.to };
}

export function progressIndexWindowSnapshot(
  state: ProgressIndexWindowState | undefined,
): ProgressIndexWindowCoordinates | undefined {
  if (!state || state.staged || state.current === undefined) return;
  return { predecessors: state.predecessors.slice(-PROGRESS_INDEX_WINDOW_PREDECESSORS), current: state.current };
}

export function startProgressIndexWindows(
  identity: string,
  current: ProgressIndexCoordinate,
): ProgressIndexWindowState {
  return { identity, predecessors: [], current };
}

export function stageProgressIndexWindow(
  state: ProgressIndexWindowState,
  target: ProgressIndexWindowTarget,
): ProgressIndexWindowState {
  return { ...state, staged: target };
}

/** Admit only the staged address after the exact current native page succeeded. */
export function admitProgressIndexWindow(
  state: ProgressIndexWindowState,
  input: {
    identity: string;
    move?: string;
    requested: ProgressIndexCoordinate;
    admitted: ProgressIndexCoordinate;
    restarted?: boolean;
    eligible: boolean;
  },
): ProgressIndexWindowState {
  if (!input.eligible || state.identity !== input.identity) return state;
  const target = state.staged;
  if (input.restarted) {
    if (state.current === null && state.predecessors.length === 0 && !target) return state;
    if (target && (input.move !== target.id || input.requested !== target.to)) return state;
    return {
      identity: input.identity,
      predecessors: [],
      current: null,
      ...(target?.keyboard && target.kind !== 'refresh' ? { lastMovement: target.id } : {}),
    };
  }
  if (target) {
    if (state.current === undefined) return state;
    if (input.move !== target.id || input.requested !== target.to) return state;
    if (input.requested !== input.admitted) return state;
    if (target.kind === 'refresh') return { ...state, staged: undefined, lastMovement: undefined };
    if (target.kind === 'first')
      return {
        identity: input.identity,
        predecessors: [],
        current: null,
        lastMovement: target.keyboard ? target.id : undefined,
      };
    if (target.kind === 'previous')
      return {
        identity: input.identity,
        predecessors: state.predecessors.slice(0, -1),
        current: input.admitted,
        lastMovement: target.keyboard ? target.id : undefined,
      };
    return {
      identity: input.identity,
      predecessors: [...state.predecessors, state.current].slice(-PROGRESS_INDEX_WINDOW_PREDECESSORS),
      current: input.admitted,
      lastMovement: target.keyboard ? target.id : undefined,
    };
  }
  if (state.current === undefined) return { identity: input.identity, predecessors: [], current: input.admitted };
  return state;
}

export function progressIndexWindowAddress(address: ProgressIndexAddress) {
  return JSON.stringify([
    address.subjectId ?? '',
    address.state ?? null,
    address.mode ?? null,
    address.profileId ?? null,
  ]);
}
