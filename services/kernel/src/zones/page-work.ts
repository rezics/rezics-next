import { Value } from 'typebox/value';
import { ZonePagePositionSchema } from './page-position.ts';
import { jsonParameter } from '../database/json.ts';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import {
  decodeListCursor,
  encodeListCursor,
  type ListCursorBinding,
  type ListCursorProfile,
} from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { zoneCursorFailure, zoneDigest, zoneUnavailable, type ZoneWork } from './membership.ts';
import type { ZoneUnionPosition } from './union.ts';
import read from './page-work-read.sql';
import save from './page-work-save.sql';
import remove from './page-work-delete.sql';

export type ZonePagePosition = {
  reads: Record<string, ZoneUnionPosition>;
  predecessor?: { generation: string; revision: string };
};

export type ZonePageWorkInput = {
  id: string;
  actor: Actor;
  body: unknown;
  basis: string;
  cursor?: string;
  route?: string;
  work: ZoneWork;
  profile?: ListCursorProfile;
  query?: ListCursorBinding['query'];
  unusable?: 'restart' | 'stale';
};

function storedPosition(value: unknown): ZonePagePosition {
  return Value.Decode(ZonePagePositionSchema, value);
}

/** Thirty-two keyed slots per Zone/viewer bound retained work independently of traversal length.
 * Replacing a slot simply restarts an evicted encrypted cursor under current authorization.
 * The Accounts codec alone supplies token lifetime; there is no Zone token/TTL/permission cache.
 */
export async function zonePageWork(deps: { pool: Pool; tokens: KeyRing; clock: () => Date }, input: ZonePageWorkInput) {
  const profile = input.profile ?? 'search';
  const request = zoneDigest(input.body);
  const key = {
    route: routeOf(input.id)!,
    zone_id: input.id,
    viewer: zoneDigest(input.actor.kind === 'account' ? input.actor.accountId : 'anonymous'),
    slot: Number.parseInt(request.slice(0, 2), 16) % 32,
  };
  const binding: ListCursorBinding = {
    route: input.route ?? 'POST /v1/zones/:id:readPage',
    viewer: input.actor.kind === 'account' ? input.actor.accountId : null,
    query: input.query ?? { zone: input.id, body: request },
  };
  const decoded = input.cursor
    ? await decodeListCursor(deps.tokens, binding, input.cursor, deps.clock(), { profile })
    : null;
  if (input.cursor && input.unusable === 'stale') {
    if (!decoded?.ok) zoneCursorFailure(decoded?.reason === 'expired' ? 'expired' : 'invalid');
  }
  input.work.select('control', 'id', 1);
  // Exact PK reads/writes; nativeRows charges plan bounds, including conflict/Zone-head points.
  const retained = await input.work.bounded({ statements: 1, nativePoints: 1, nativeRows: 1, bytes: 1049600 }, () =>
    read.run(deps.pool, key),
  );
  const current =
    decoded?.ok &&
    decoded.epoch === 1 &&
    decoded.after.length === 3 &&
    decoded.after[0] === input.basis &&
    retained?.request === request &&
    retained.basis === input.basis &&
    decoded.after[1] === retained.generation &&
    decoded.after[2] === retained.revision;
  const stored = retained ? storedPosition(retained.position) : undefined;
  const predecessor =
    decoded?.ok &&
    stored?.predecessor &&
    decoded.epoch === 1 &&
    decoded.after.length === 3 &&
    decoded.after[0] === input.basis &&
    retained?.request === request &&
    retained.basis === input.basis &&
    decoded.after[1] === stored.predecessor.generation &&
    decoded.after[2] === stored.predecessor.revision;
  const usable = Boolean(current || predecessor);
  if (input.cursor && input.unusable === 'stale' && decoded?.ok && !usable) zoneCursorFailure('stale');
  const generation = usable ? retained!.generation : randomUUID();
  const position: ZonePagePosition = usable ? { reads: stored!.reads } : { reads: {} };
  const revision = retained?.revision;
  return {
    position,
    usable,
    async progress(next: ZonePagePosition) {
      const writes = { reads: next.reads };
      if (zoneDigest(writes) === zoneDigest({ reads: position.reads })) return zoneUnavailable();
      input.work.select('control', 'id', 1);
      const [saved] = await input.work.bounded({ statements: 1, nativePoints: 2, nativeRows: 3, bytes: 1049600 }, () =>
        save.run(deps.pool, {
          ...key,
          request,
          basis: input.basis,
          generation,
          expected: revision ?? '0',
          position: jsonParameter({
            ...writes,
            ...(usable && retained
              ? { predecessor: { generation: retained.generation, revision: retained.revision } }
              : {}),
          }),
        }),
      );
      if (!saved) return zoneUnavailable();
      return encodeListCursor(
        deps.tokens,
        binding,
        {
          epoch: 1,
          after: [input.basis, generation, saved.revision],
        },
        deps.clock(),
        { profile },
      );
    },
    async finish() {
      input.work.select('control', 'id', 1);
      if (usable)
        await input.work.bounded({ statements: 1, nativePoints: 1, nativeRows: 1 }, () =>
          remove.run(deps.pool, { ...key, generation, revision: retained!.revision }),
        );
    },
  };
}
