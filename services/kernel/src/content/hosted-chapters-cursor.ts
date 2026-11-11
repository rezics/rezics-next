import { createHash } from 'node:crypto';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import { routeOf } from '../route/route.ts';
import type { ReadContext } from './model.ts';
import {
  InvalidHostedCursorError,
  type HostedDependencies,
  type HostedReadSelection,
} from './hosted-chapters-model.ts';

export type HostedCursorState = Readonly<{
  revisionId: string;
  after: number;
  origin: number;
  issuedAt: number;
  epoch: number;
}>;
export function hostedCursorBinding(
  catalogueId: string,
  selection: HostedReadSelection,
  context: ReadContext,
  query: Readonly<{
    mode: 'children' | 'previous' | 'next';
    parentId: string | null;
    occurrenceId: string | null;
    limit: number;
  }>,
): CursorBinding {
  const actor = context.actor;
  const viewer =
    actor.kind === 'anonymous'
      ? 'anonymous'
      : createHash('sha256')
          .update(
            JSON.stringify([
              actor.accountId,
              actor.clientId,
              actor.requestedBy,
              actor.authnEpoch,
              [...actor.scopes].sort(),
            ]),
          )
          .digest('hex');
  return {
    operation: 'content.hosted-catalogue.page',
    parameters: {
      catalogueId,
      revisionId: selection.revisionId ?? null,
      kind: selection.kind ?? null,
      viewer,
      ...query,
    },
  };
}
export function readHostedCursor(
  deps: HostedDependencies,
  binding: CursorBinding,
  catalogueId: string,
  token: string | undefined,
): HostedCursorState | null {
  if (token === undefined) return null;
  const decoded = decodeCursor(deps.tokens, binding, token, deps.clock().getTime());
  if (!decoded.ok || decoded.after.length !== 4) throw new InvalidHostedCursorError();
  const [revisionId, after, origin, issuedAt] = decoded.after;
  if (
    typeof revisionId !== 'string' ||
    routeOf(revisionId) !== routeOf(catalogueId) ||
    typeof after !== 'number' ||
    after < 0 ||
    after > 511 ||
    typeof origin !== 'number' ||
    origin < -1 ||
    origin > 511 ||
    typeof issuedAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > deps.clock().getTime() + 60_000 ||
    deps.clock().getTime() - issuedAt > 15 * 60_000
  )
    throw new InvalidHostedCursorError();
  return { revisionId, after, origin, issuedAt, epoch: decoded.epoch };
}
export function writeHostedCursor(deps: HostedDependencies, binding: CursorBinding, state: HostedCursorState): string {
  // Preserve the first page's lifetime; continuation cannot renew the original frontier.
  return encodeCursor(
    deps.tokens,
    binding,
    { epoch: state.epoch, after: [state.revisionId, state.after, state.origin, state.issuedAt] },
    state.issuedAt,
  );
}
