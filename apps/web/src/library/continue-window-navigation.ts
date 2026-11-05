import type { QueryClient } from '@tanstack/react-query';
import { sessionQueryKey } from '../session/browser-state';

export const CONTINUE_WINDOW_QUERY_KEY = ['library-continue-window-navigation'] as const;
export const CONTINUE_WINDOW_MAX_PREDECESSORS = 8;
const MAX_PATH_LENGTH = CONTINUE_WINDOW_MAX_PREDECESSORS + 1;

export type ContinueCursor = string | null;
export type ContinueWindowDirection = 'next' | 'previous' | 'first';

type ContinueWindowOwner = {
  locale: string;
  source: object;
  sessionQuery: object | undefined;
  sessionUpdateCount: number;
  sessionUpdatedAt: number;
};

export type ContinueWindowStage = {
  from: ContinueCursor;
  target: ContinueCursor;
  direction: ContinueWindowDirection;
  restoreHeadingFocus: boolean;
};

export type ContinueWindowVisit = {
  visitId: string;
  owner: ContinueWindowOwner;
  /** Accepted coordinates in native order, with the current or most recent coordinate last. */
  path: ContinueCursor[];
  staged: ContinueWindowStage | null;
};

export type ContinueWindowTarget = { target: ContinueCursor };

function sessionVersion(client: QueryClient) {
  return {
    sessionQuery: client.getQueryCache().find({ queryKey: sessionQueryKey, exact: true }),
    sessionUpdateCount: client.getQueryState(sessionQueryKey)?.dataUpdateCount ?? 0,
    sessionUpdatedAt: client.getQueryState(sessionQueryKey)?.dataUpdatedAt ?? 0,
  };
}

export function continueWindowOwner(client: QueryClient, locale: string, source: object): ContinueWindowOwner {
  return { locale, source, ...sessionVersion(client) };
}

export function sameContinueWindowOwner(left: ContinueWindowOwner, right: ContinueWindowOwner): boolean {
  return (
    left.locale === right.locale &&
    left.source === right.source &&
    left.sessionQuery === right.sessionQuery &&
    left.sessionUpdateCount === right.sessionUpdateCount &&
    left.sessionUpdatedAt === right.sessionUpdatedAt
  );
}

export function continueWindowVisit(
  client: QueryClient,
  visitId: string | undefined,
  owner: ContinueWindowOwner,
): ContinueWindowVisit | undefined {
  if (!visitId) return undefined;
  const visit = client.getQueryData<ContinueWindowVisit>(CONTINUE_WINDOW_QUERY_KEY);
  return visit?.visitId === visitId && sameContinueWindowOwner(visit.owner, owner) ? visit : undefined;
}

export function continueWindowPrevious(
  visit: ContinueWindowVisit | undefined,
  current: ContinueCursor,
): ContinueWindowTarget | undefined {
  if (!visit) return undefined;
  const index = visit.path.lastIndexOf(current);
  return index > 0 ? { target: visit.path[index - 1]! } : undefined;
}

export function stageContinueWindow(
  client: QueryClient,
  input: {
    visitId: string;
    owner: ContinueWindowOwner;
    current: ContinueCursor;
    target: ContinueCursor;
    direction: ContinueWindowDirection;
    restoreHeadingFocus: boolean;
  },
): boolean {
  const saved = client.getQueryData<ContinueWindowVisit>(CONTINUE_WINDOW_QUERY_KEY);
  const visit =
    saved?.visitId === input.visitId && sameContinueWindowOwner(saved.owner, input.owner)
      ? saved
      : { visitId: input.visitId, owner: input.owner, path: [input.current], staged: null };
  if (visit.staged) return false;
  const index = visit.path.lastIndexOf(input.current);
  const path = index < 0 ? [input.current] : visit.path.slice(0, index + 1);
  client.setQueryData<ContinueWindowVisit>(CONTINUE_WINDOW_QUERY_KEY, {
    ...visit,
    owner: input.owner,
    path,
    staged: {
      from: input.current,
      target: input.target,
      direction: input.direction,
      restoreHeadingFocus: input.restoreHeadingFocus,
    },
  });
  return true;
}

/** Commit only the staged address whose own current native read succeeded. */
export function acceptContinueWindow(
  client: QueryClient,
  input: {
    visitId: string | undefined;
    owner: ContinueWindowOwner;
    current: ContinueCursor;
    loaded: boolean;
  },
): { committed: boolean; restoreHeadingFocus: boolean } {
  const visit = continueWindowVisit(client, input.visitId, input.owner);
  const stage = visit?.staged;
  if (!visit || !stage || !input.loaded || stage.target !== input.current)
    return { committed: false, restoreHeadingFocus: false };

  let path: ContinueCursor[];
  if (stage.direction === 'first') {
    path = [null];
  } else if (stage.direction === 'previous') {
    const targetIndex = visit.path.lastIndexOf(stage.target);
    path = visit.path.slice(0, targetIndex + 1);
  } else {
    const fromIndex = visit.path.lastIndexOf(stage.from);
    const prefix = fromIndex < 0 ? [stage.from] : visit.path.slice(0, fromIndex + 1);
    const existingTargetIndex = prefix.lastIndexOf(stage.target);
    path = existingTargetIndex < 0 ? [...prefix, stage.target] : prefix.slice(0, existingTargetIndex + 1);
  }
  if (path.length > MAX_PATH_LENGTH) path = path.slice(path.length - MAX_PATH_LENGTH);
  client.setQueryData<ContinueWindowVisit>(CONTINUE_WINDOW_QUERY_KEY, {
    ...visit,
    path,
    staged: null,
  });
  return { committed: true, restoreHeadingFocus: stage.restoreHeadingFocus };
}

export function abandonContinueWindowStage(client: QueryClient, visitId: string | undefined): boolean {
  const visit = client.getQueryData<ContinueWindowVisit>(CONTINUE_WINDOW_QUERY_KEY);
  if (!visitId || visit?.visitId !== visitId || !visit.staged) return false;
  client.setQueryData<ContinueWindowVisit>(CONTINUE_WINDOW_QUERY_KEY, { ...visit, staged: null });
  return true;
}

export function retireContinueWindow(client: QueryClient): void {
  client.removeQueries({ queryKey: CONTINUE_WINDOW_QUERY_KEY, exact: true });
}

export function isContinueSessionQuery(queryKey: readonly unknown[]): boolean {
  return queryKey.length === 1 && queryKey[0] === sessionQueryKey[0];
}
