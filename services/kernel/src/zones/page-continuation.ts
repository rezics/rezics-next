import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import type { Static } from 'typebox';
import {
  decodeListCursor,
  encodeListCursor,
  LIST_CURSOR_BOUNDS,
  type ListCursorBinding,
} from '../tokens/list-cursor.ts';
import type { Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';

const closed = { additionalProperties: false } as const;
function cursorSchema() {
  return memoizedValue(cursorSchema, () =>
    t.String({
      minLength: 1,
      maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength,
      pattern: '^[A-Za-z0-9_-]+$',
    }),
  );
}

/** Query parameters for a bounded Zone page read. The cursor is opaque to this transport schema. */
export function ZonePageQuerySchema() {
  return memoizedValue(ZonePageQuerySchema, () => t.Object({ cursor: t.Optional(cursorSchema()) }, closed));
}

/** A distinct 202 response indicating that a Zone page read can continue. */
export function ZonePageReadProgressSchema() {
  return memoizedValue(ZonePageReadProgressSchema, () => t.Object({ next: cursorSchema() }, closed));
}

function defaultCursorSchema() {
  return memoizedValue(defaultCursorSchema, () =>
    t.String({
      minLength: 1,
      maxLength: LIST_CURSOR_BOUNDS.default.maxTokenLength,
      pattern: '^[A-Za-z0-9_-]+$',
    }),
  );
}

/** Default-profile query for GET /v1/zones/:id/subjects. */
export function ZoneSubjectListQuerySchema() {
  return memoizedValue(ZoneSubjectListQuerySchema, () =>
    t.Object(
      {
        limit: t.Optional(t.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
        cursor: t.Optional(defaultCursorSchema()),
      },
      closed,
    ),
  );
}

export function ZoneSubjectListProgressSchema() {
  return memoizedValue(ZoneSubjectListProgressSchema, () => t.Object({ next: defaultCursorSchema() }, closed));
}

export type ZonePageQuery = Static<ReturnType<typeof ZonePageQuerySchema>>;
export type ZonePageReadProgress = Static<ReturnType<typeof ZonePageReadProgressSchema>>;
export type ZoneSubjectListQuery = Static<ReturnType<typeof ZoneSubjectListQuerySchema>>;
export type ZoneSubjectListProgress = Static<ReturnType<typeof ZoneSubjectListProgressSchema>>;

const COLLECTIONS_CURSOR_EPOCH = 1;
const COLLECTIONS_CURSOR_ROUTE = 'GET /v1/zones/{id}/collections';

export type ZoneCollectionsCursorBinding = ListCursorBinding;
export type ZoneCollectionsCursor =
  | { ok: true; after: string | null; revision: string; lifecycleRevision: string }
  | { ok: false; reason: 'invalid' | 'stale' };

export function zoneCollectionsCursorBinding(
  actor: Actor,
  zoneId: string,
  limit: number,
): ZoneCollectionsCursorBinding {
  return {
    route: COLLECTIONS_CURSOR_ROUTE,
    viewer: actor.kind === 'account' ? actor.accountId : null,
    query: { zoneId, limit },
  };
}

export async function decodeZoneCollectionsCursor(
  tokens: KeyRing,
  binding: ZoneCollectionsCursorBinding,
  cursor: string | undefined,
  now: Date,
  basis: { revision: string; lifecycleRevision: string },
): Promise<ZoneCollectionsCursor> {
  if (cursor === undefined)
    return { ok: true, after: null, revision: basis.revision, lifecycleRevision: basis.lifecycleRevision };
  const decoded = await decodeListCursor(tokens, binding, cursor, now);
  if (!decoded.ok) return { ok: false, reason: 'invalid' };
  const [idAfter, revision, lifecycleRevision] = decoded.after;
  if (
    decoded.epoch !== COLLECTIONS_CURSOR_EPOCH ||
    decoded.after.length !== 3 ||
    typeof idAfter !== 'string' ||
    typeof revision !== 'string' ||
    typeof lifecycleRevision !== 'string'
  )
    return { ok: false, reason: 'invalid' };
  if (revision !== basis.revision || lifecycleRevision !== basis.lifecycleRevision)
    return { ok: false, reason: 'stale' };
  return { ok: true, after: idAfter, revision, lifecycleRevision };
}

export async function encodeZoneCollectionsCursor(
  tokens: KeyRing,
  binding: ZoneCollectionsCursorBinding,
  position: { id: string; revision: string; lifecycleRevision: string },
  now: Date,
): Promise<string> {
  return encodeListCursor(
    tokens,
    binding,
    { epoch: COLLECTIONS_CURSOR_EPOCH, after: [position.id, position.revision, position.lifecycleRevision] },
    now,
  );
}
