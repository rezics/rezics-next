import type { Pool, PoolClient } from 'pg';

export class ContentErasureInvalid extends Error {}
/** A revision already pinned for graph publication needs graph suppression first. */
export class ContentErasureGraphRequired extends Error {}
export class ContentErasureStale extends Error {}

/** Same item ceiling as Content's exact batch read; one transaction locks at most this many rows. */
export const MAX_CONTENT_ERASURE_TARGETS = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface TargetRow {
  id: string;
  resource_id: string;
  availability: string;
  pinned: boolean;
  erasure_id: string | null;
}

function checkIds(revisionIds: readonly string[]): void {
  if (!revisionIds.length || revisionIds.length > MAX_CONTENT_ERASURE_TARGETS
    || new Set(revisionIds).size !== revisionIds.length || revisionIds.some(id => !UUID.test(id))) {
    throw new ContentErasureInvalid('Content erasure targets are invalid');
  }
}

async function targetRows(client: Pool | PoolClient, revisionIds: readonly string[],
  lock: boolean): Promise<TargetRow[]> {
  return (await client.query<TargetRow>(`SELECT r.id, v.resource_id, r.availability,
      EXISTS (SELECT 1 FROM content.publication_preparation p
        WHERE p.revision_id = r.id AND p.pin_active) AS pinned,
      t.erasure_id
    FROM content.revision r JOIN content.variant v ON v.id = r.variant_id
    LEFT JOIN content.revision_erasure t ON t.revision_id = r.id
    WHERE r.id = ANY($1::uuid[]) ORDER BY r.id${lock ? ' FOR UPDATE OF r' : ''}`,
  [revisionIds])).rows;
}

function assertTargets(rows: readonly TargetRow[], revisionIds: readonly string[],
  resourceId: string, erasureId: string | null): void {
  if (rows.length !== revisionIds.length || rows.some(row => row.resource_id !== resourceId)) {
    throw new ContentErasureInvalid('Content erasure targets are unavailable');
  }
  if (rows.some(row => row.erasure_id ? row.erasure_id !== erasureId
    : row.availability !== 'available')) {
    throw new ContentErasureStale('Content revision is no longer available to erase');
  }
  if (rows.some(row => row.pinned && !(erasureId && row.erasure_id === erasureId))) {
    throw new ContentErasureGraphRequired('published Content needs graph suppression');
  }
}

/** One bounded read before journaling: owned by the resource, unpublished and available. */
export async function checkContentErasureTargets(content: Pool, resourceId: string,
  revisionIds: readonly string[]): Promise<void> {
  checkIds(revisionIds);
  assertTargets(await targetRows(content, revisionIds, false), revisionIds, resourceId, null);
}

export interface ContentErasureCommand {
  erasureId: string;
  erasureEpoch: string;
  resourceId: string;
  revisionIds: readonly string[];
}

/**
 * Apply one journaled erasure to the Content owner: a non-sensitive tombstone and
 * the erased transition commit together. Replays of the same erasure are no-ops.
 * No Content receipt or outbox event is written: the relay journal is the
 * command's owner and the tombstone is its local idempotency record.
 */
export async function applyContentErasure(content: Pool, command: ContentErasureCommand): Promise<{
  applied: number }> {
  checkIds(command.revisionIds);
  if (!UUID.test(command.erasureId) || !/^[1-9][0-9]{0,18}$/.test(command.erasureEpoch)) {
    throw new ContentErasureInvalid('Content erasure journal identity is invalid');
  }
  const client = await content.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const rows = await targetRows(client, command.revisionIds, true);
    assertTargets(rows, command.revisionIds, command.resourceId, command.erasureId);
    const pending = rows.filter(row => !row.erasure_id).map(row => row.id);
    if (pending.length) {
      await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        SELECT unnest($1::uuid[]), $2, $3`, [pending, command.erasureId, command.erasureEpoch]);
      await client.query(`UPDATE content.revision SET availability = 'erased',
          serialized_bytes = NULL, body = NULL
        WHERE id = ANY($1::uuid[]) AND availability = 'available'`, [pending]);
    }
    await client.query('COMMIT');
    return { applied: pending.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export type ContentErasureProbe = 'erased' | 'absent' | 'available' | 'foreign';

/** Per-revision state of a journaled erasure in one Content copy, in one bounded read. */
export async function probeContentErasure(content: Pool, erasureId: string,
  revisionIds: readonly string[]): Promise<Map<string, ContentErasureProbe>> {
  if (revisionIds.length > 256) throw new ContentErasureInvalid('Content erasure probe is too large');
  const rows = (await content.query<{ id: string; availability: string | null;
    erasure_id: string | null }>(`SELECT wanted.id::text AS id, r.availability, t.erasure_id
    FROM unnest($1::uuid[]) AS wanted(id)
    LEFT JOIN content.revision r ON r.id = wanted.id
    LEFT JOIN content.revision_erasure t ON t.revision_id = wanted.id`, [revisionIds])).rows;
  return new Map(rows.map(row => [row.id, row.availability === null ? 'absent'
    : row.erasure_id === erasureId && row.availability === 'erased' ? 'erased'
      : row.availability === 'available' && !row.erasure_id ? 'available' : 'foreign']));
}

/** The owning resource of journaled revisions; a completion retry rebuilds its Access scope. */
export async function contentErasureResource(content: Pool, revisionIds: readonly string[]): Promise<string> {
  const rows = (await content.query<{ resource_id: string }>(`SELECT DISTINCT v.resource_id
    FROM content.revision r JOIN content.variant v ON v.id = r.variant_id
    WHERE r.id = ANY($1::uuid[])`, [revisionIds])).rows;
  if (rows.length !== 1) throw new ContentErasureInvalid('Content erasure resource is unavailable');
  return rows[0]!.resource_id;
}
