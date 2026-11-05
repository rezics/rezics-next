import type { QueryClient } from '@tanstack/react-query';
import { sessionQueryKey } from '../session/browser-state';
import { LABELS_CURSOR_MAX_LENGTH } from './labels-address';

export const LABELS_WINDOW_QUERY_KEY = ['library-labels-window-navigation'] as const;
export const LABELS_WINDOW_MAX_PREDECESSORS = 8;
const MAX_PATH_LENGTH = LABELS_WINDOW_MAX_PREDECESSORS + 1;

export type LabelsCursor = string | null;
export type LabelsWindowDirection = 'next' | 'previous' | 'first';

export type LabelsWindowOwner = {
  locale: string;
  query: string | null;
  source: object;
  viewer: number;
  listEpoch: number;
  sessionUpdateCount: number;
  sessionUpdatedAt: number;
};

export type LabelsWindowStage = {
  from: LabelsCursor;
  target: LabelsCursor;
  direction: LabelsWindowDirection;
  restoreHeadingFocus: boolean;
};

export type LabelsWindowVisit = {
  visitId: string;
  owner: LabelsWindowOwner;
  /** Accepted coordinates in native order, with the current coordinate last. */
  path: LabelsCursor[];
  staged: LabelsWindowStage | null;
};

function sessionVersion(client: QueryClient) {
  return {
    sessionUpdateCount: client.getQueryState(sessionQueryKey)?.dataUpdateCount ?? 0,
    sessionUpdatedAt: client.getQueryState(sessionQueryKey)?.dataUpdatedAt ?? 0,
  };
}

export function labelsWindowOwner(
  client: QueryClient,
  input: { locale: string; query: string | null; source: object; viewer: number; listEpoch: number },
): LabelsWindowOwner {
  return { ...input, ...sessionVersion(client) };
}

export function sameLabelsWindowOwner(left: LabelsWindowOwner, right: LabelsWindowOwner): boolean {
  return (
    left.locale === right.locale &&
    left.query === right.query &&
    left.source === right.source &&
    left.viewer === right.viewer &&
    left.listEpoch === right.listEpoch &&
    left.sessionUpdateCount === right.sessionUpdateCount &&
    left.sessionUpdatedAt === right.sessionUpdatedAt
  );
}

/** Reader lifetime excludes the raw prefix and locale so their failed reads do not retire an accepted path. */
export function sameLabelsWindowReader(left: LabelsWindowOwner, right: LabelsWindowOwner): boolean {
  return (
    left.source === right.source &&
    left.viewer === right.viewer &&
    left.listEpoch === right.listEpoch &&
    left.sessionUpdateCount === right.sessionUpdateCount &&
    left.sessionUpdatedAt === right.sessionUpdatedAt
  );
}

export function labelsWindowVisit(
  client: QueryClient,
  visitId: string | undefined,
  owner: LabelsWindowOwner,
): LabelsWindowVisit | undefined {
  if (!visitId) return undefined;
  const visit = client.getQueryData<LabelsWindowVisit>(LABELS_WINDOW_QUERY_KEY);
  return visit?.visitId === visitId && sameLabelsWindowOwner(visit.owner, owner) ? visit : undefined;
}

export function labelsWindowHasPrevious(visit: LabelsWindowVisit | undefined, current: LabelsCursor): boolean {
  if (!visit) return false;
  return visit.path.lastIndexOf(current) > 0;
}

export function labelsWindowPrevious(visit: LabelsWindowVisit | undefined, current: LabelsCursor) {
  if (!visit) return undefined;
  const index = visit.path.lastIndexOf(current);
  return index > 0 ? visit.path[index - 1] : undefined;
}

/** Stage only the one target. Accepted history changes only after its exact current read succeeds. */
export function stageLabelsWindow(
  client: QueryClient,
  input: {
    visitId: string;
    owner: LabelsWindowOwner;
    current: LabelsCursor;
    target: LabelsCursor;
    direction: LabelsWindowDirection;
    restoreHeadingFocus: boolean;
  },
): boolean {
  if (
    (input.current !== null && input.current.length > LABELS_CURSOR_MAX_LENGTH) ||
    (input.target !== null && input.target.length > LABELS_CURSOR_MAX_LENGTH)
  )
    return false;
  const saved = client.getQueryData<LabelsWindowVisit>(LABELS_WINDOW_QUERY_KEY);
  const visit =
    saved?.visitId === input.visitId && sameLabelsWindowOwner(saved.owner, input.owner)
      ? saved
      : { visitId: input.visitId, owner: input.owner, path: [input.current], staged: null };
  if (input.direction === 'first' && input.target !== null) return false;
  if (input.direction === 'previous' && labelsWindowPrevious(visit, input.current) !== input.target) return false;
  client.setQueryData<LabelsWindowVisit>(LABELS_WINDOW_QUERY_KEY, {
    ...visit,
    staged: {
      from: input.current,
      target: input.target,
      direction: input.direction,
      restoreHeadingFocus: input.restoreHeadingFocus,
    },
  });
  return true;
}

/** Commit only a staged coordinate whose exact response has passed the current reader guard. */
export function acceptLabelsWindow(
  client: QueryClient,
  input: {
    visitId: string | undefined;
    owner: LabelsWindowOwner;
    current: LabelsCursor;
    loaded: boolean;
  },
): { committed: boolean; restoreHeadingFocus: boolean } {
  const visit = labelsWindowVisit(client, input.visitId, input.owner);
  const stage = visit?.staged;
  if (!visit || !stage || !input.loaded || stage.target !== input.current)
    return { committed: false, restoreHeadingFocus: false };

  let path: LabelsCursor[];
  if (stage.direction === 'first') {
    path = [null];
  } else if (stage.direction === 'previous') {
    const targetIndex = visit.path.lastIndexOf(stage.target);
    if (targetIndex < 0) throw new Error('Staged Labels predecessor is not in accepted history');
    path = visit.path.slice(0, targetIndex + 1);
  } else {
    const fromIndex = visit.path.lastIndexOf(stage.from);
    const prefix = fromIndex < 0 ? [stage.from] : visit.path.slice(0, fromIndex + 1);
    const targetIndex = prefix.lastIndexOf(stage.target);
    path = targetIndex < 0 ? [...prefix, stage.target] : prefix.slice(0, targetIndex + 1);
  }
  if (path.length > MAX_PATH_LENGTH) path = path.slice(path.length - MAX_PATH_LENGTH);
  client.setQueryData<LabelsWindowVisit>(LABELS_WINDOW_QUERY_KEY, { ...visit, path, staged: null });
  return { committed: true, restoreHeadingFocus: stage.restoreHeadingFocus };
}

export function cancelLabelsWindowFocus(client: QueryClient, visitId: string | undefined): boolean {
  const visit = client.getQueryData<LabelsWindowVisit>(LABELS_WINDOW_QUERY_KEY);
  if (!visitId || visit?.visitId !== visitId || !visit.staged?.restoreHeadingFocus) return false;
  client.setQueryData<LabelsWindowVisit>(LABELS_WINDOW_QUERY_KEY, {
    ...visit,
    staged: { ...visit.staged, restoreHeadingFocus: false },
  });
  return true;
}

export function retireLabelsWindow(client: QueryClient): void {
  client.removeQueries({ queryKey: LABELS_WINDOW_QUERY_KEY, exact: true });
}

export function isLabelsSessionQuery(queryKey: readonly unknown[]): boolean {
  return queryKey.length === 1 && queryKey[0] === sessionQueryKey[0];
}
