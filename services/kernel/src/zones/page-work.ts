import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { zoneDigest, zoneUnavailable } from './membership.ts';
import type { ZoneUnionPosition } from './union.ts';
import read from './page-work-read.sql';
import save from './page-work-save.sql';
import remove from './page-work-delete.sql';

export type ZonePagePosition = { reads: Record<string, ZoneUnionPosition> };
/** Thirty-two keyed slots per Zone/viewer bound retained work independently of traversal length.
 * Replacing a slot simply restarts an evicted encrypted cursor under current authorization.
 * The Accounts codec alone supplies token lifetime; there is no Zone token/TTL/permission cache.
 */
export async function zonePageWork(
  deps: { pool: Pool; tokens: KeyRing; clock: () => Date },
  input: { id: string; actor: Actor; body: unknown; basis: string; cursor?: string; route?: string },
) {
  const request = zoneDigest(input.body);
  const key = {
    route: routeOf(input.id)!, zone_id: input.id,
    viewer: zoneDigest(input.actor.kind === 'account' ? input.actor.accountId : 'anonymous'),
    slot: Number.parseInt(request.slice(0, 2), 16) % 32,
  };
  const binding: ListCursorBinding = {
    route: input.route ?? 'POST /v1/zones/:id:readPage',
    viewer: input.actor.kind === 'account' ? input.actor.accountId : null,
    query: { zone: input.id, body: request },
  };
  const decoded = input.cursor ? await decodeListCursor(deps.tokens, binding, input.cursor, deps.clock(), { profile: 'search' }) : null;
  const retained = await read.run(deps.pool, key);
  const usable = decoded?.ok && decoded.epoch === 1 && decoded.after.length === 3 &&
    decoded.after[0] === input.basis && retained?.request === request && retained.basis === input.basis &&
    decoded.after[1] === retained.generation && decoded.after[2] === retained.revision;
  const generation = usable ? retained.generation : randomUUID();
  const position = usable ? retained.position as ZonePagePosition : { reads: {} };
  const revision = retained?.revision;
  return {
    position,
    async progress(next: ZonePagePosition) {
      if (zoneDigest(next) === zoneDigest(position)) return zoneUnavailable();
      const [stored] = await save.run(deps.pool, {
        ...key, request, basis: input.basis, generation,
        expected: revision ?? null, position: next,
      });
      if (!stored) return zoneUnavailable();
      return encodeListCursor(deps.tokens, binding, {
        epoch: 1, after: [input.basis, generation, stored.revision],
      }, deps.clock(), { profile: 'search' });
    },
    async finish() {
      if (usable) await remove.run(deps.pool, { ...key, generation, revision: retained.revision });
    },
  };
}
