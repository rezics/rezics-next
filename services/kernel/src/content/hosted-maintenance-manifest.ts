/** Read-only input for one-time development maintenance. The public application reads ordered selections. */
import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import {
  HOSTED_PAGE_LIMIT,
  HOSTED_PLACEMENT_LIMIT,
  InvalidHostedStructureError,
  type OrderedHostedPlacement,
  type HostedAppendDescriptor,
} from './hosted-chapters-model.ts';
import appendExact from './hosted-append-read-exact.sql';
import appendNext from './hosted-append-read-next.sql';
import appendPrevious from './hosted-append-read-previous.sql';
import appendRelease from './hosted-append-release-selected.sql';
import { hostedAppendDescriptor } from './hosted-chapters-append.ts';

export type HostedPlacementRow = {
  occurrence_id: string;
  parent_id: string | null;
  position: number;
  ordinal: number;
  title: string | null;
  kind: 'part' | 'chapter';
  thread_id: string | null;
  post_id: string | null;
  target_revision_id: string | null;
  sha256: string | null;
};
export const HOSTED_PLACEMENT_SELECT = `
  SELECT p.occurrence_id,p.parent_id,p.position,p.ordinal,p.title,o.kind,o.thread_id,o.post_id,
    p.target_revision_id,encode(p.body_sha256,'hex') AS sha256
  FROM content.hosted_placement p
  JOIN content.hosted_occurrence o USING (route,catalogue_id,occurrence_id)
  WHERE p.route=$1 AND p.catalogue_id=$2 AND p.revision_id=$3`;

export function hostedPlacement(row: HostedPlacementRow): OrderedHostedPlacement {
  // Terminal payload tombstones must never become editable placements or labels.
  if (row.title === null) throw new Error('Redacted hosted placement is unavailable');
  const base = {
    occurrenceId: row.occurrence_id,
    parentId: row.parent_id,
    position: row.position,
    ordinal: row.ordinal,
    title: row.title,
  };
  if (row.kind === 'part') return { ...base, kind: 'part' };
  if (!row.thread_id || !row.post_id || !row.target_revision_id || !row.sha256)
    throw new Error('Invalid hosted chapter binding');
  return {
    ...base,
    kind: 'chapter',
    target: {
      threadId: row.thread_id,
      postId: row.post_id,
      revisionId: row.target_revision_id,
      sha256: row.sha256,
    },
  };
}
/** Append offsets cross the PostgreSQL bigint boundary as decimal text. Do not
 * decode them through pg's number parser: rounding there loses exact old links.
 * The immutable descriptor's checked counts bound both derived addresses. */
type HostedAppendReadRow = {
  append_offset: string;
  occurrence_id: string;
  title: string | null;
  thread_id: string | null;
  post_id: string | null;
  target_revision_id: string;
  sha256: string;
};

function appendedPlacement(row: HostedAppendReadRow, descriptor: HostedAppendDescriptor): OrderedHostedPlacement {
  const offset = BigInt(row.append_offset);
  return hostedPlacement({
    ...row,
    parent_id: null,
    kind: 'chapter',
    position: Number(descriptor.baseRootCount + offset),
    ordinal: Number(descriptor.basePlacementCount + offset),
  });
}

/** Exact immutable membership has two keys, never a descriptor chain. A legacy
 * snapshot or frozen publication keeps its original placement primary key.
 * The append occurrence key is also fenced by the selected high-water mark. */
export async function hostedReadPlacement(
  client: AccessClient,
  id: string,
  revisionId: string,
  occurrenceId: string,
  descriptor: HostedAppendDescriptor | null,
): Promise<OrderedHostedPlacement | null> {
  const row = (
    await client.query<HostedPlacementRow>(`${HOSTED_PLACEMENT_SELECT} AND p.occurrence_id=$4`, [
      routeOf(id),
      id,
      descriptor?.baseRevisionId ?? revisionId,
      occurrenceId,
    ])
  ).rows[0];
  if (row) return hostedPlacement(row);
  if (!descriptor || descriptor.highWater < 0n) return null;
  const appended = await appendExact.run(client, {
    route: routeOf(id)!,
    catalogue_id: id,
    stream_id: descriptor.baseRevisionId,
    occurrence_id: occurrenceId,
    high_water: descriptor.highWater.toString(),
  });
  return appended ? appendedPlacement(appended, descriptor) : null;
}

export type HostedPlacementPageQuery = Readonly<{
  mode: 'children' | 'outline' | 'previous' | 'next';
  parentId: string | null;
  after: number;
  /** Raw candidate bound, including the one continuation sentinel. */
  limit: number;
}>;

/** One indexed segment seek. bigint parameter casts let an append frontier above
 * int4's range seek the legacy index without narrowing or casting its column.
 * Nested children retain parent/position order; navigation skips parts in SQL. */
async function hostedBasePage(
  client: AccessClient,
  id: string,
  revisionId: string,
  query: HostedPlacementPageQuery,
): Promise<OrderedHostedPlacement[]> {
  const values: unknown[] = [routeOf(id), id, revisionId, query.after, query.limit];
  let condition: string;
  if (query.mode === 'children') {
    condition = ' AND p.position>$4::bigint AND ';
    if (query.parentId === null) condition += 'p.parent_id IS NULL';
    else {
      condition += 'p.parent_id=$6';
      values.push(query.parentId);
    }
  } else if (query.mode === 'outline') condition = ' AND p.ordinal>$4::bigint';
  else
    condition = ` AND p.target_revision_id IS NOT NULL AND p.ordinal${query.mode === 'previous' ? '<' : '>'}$4::bigint`;
  const order = query.mode === 'children' ? 'p.position' : `p.ordinal ${query.mode === 'previous' ? 'DESC' : 'ASC'}`;
  const result = await client.query<HostedPlacementRow>(
    `${HOSTED_PLACEMENT_SELECT}${condition} ORDER BY ${order} LIMIT $5`,
    values,
  );
  return result.rows.map(hostedPlacement);
}

/** There are exactly two non-overlapping address ranges: all base positions
 * precede every append position. Concatenating in traversal order and taking
 * one bounded prefix is the merge; no sort, refill, history walk or count is
 * needed. At most twice query.limit rows can enter it. Disclosures happen later
 * and cannot change this raw frontier or the continuation sentinel. */
export async function hostedReadPlacementPage(
  client: AccessClient,
  id: string,
  revisionId: string,
  query: HostedPlacementPageQuery,
  descriptor: HostedAppendDescriptor | null,
): Promise<OrderedHostedPlacement[]> {
  const base = await hostedBasePage(client, id, descriptor?.baseRevisionId ?? revisionId, query);
  if (!descriptor || descriptor.highWater < 0n || (query.mode === 'children' && query.parentId !== null)) return base;
  const parameters = {
    route: routeOf(id)!,
    catalogue_id: id,
    stream_id: descriptor.baseRevisionId,
    after_offset: (
      BigInt(query.after) - (query.mode === 'children' ? descriptor.baseRootCount : descriptor.basePlacementCount)
    ).toString(),
    high_water: descriptor.highWater.toString(),
    limit: query.limit,
  };
  const rows =
    query.mode === 'previous' ? await appendPrevious.run(client, parameters) : await appendNext.run(client, parameters);
  const append = rows.map((row) => appendedPlacement(row, descriptor));
  return (query.mode === 'previous' ? [...append, ...base] : [...base, ...append]).slice(0, query.limit);
}

/** Read only explicit release candidates from the immutable source revision.
 * A mixed draft has exactly two segments: the sealed base precedes its pinned
 * append prefix. Each uses one bounded exact-ID lookup in native ordinal order;
 * neither probes siblings, follows history nor fills missing selections. */
export async function hostedReleasePlacements(
  client: AccessClient,
  id: string,
  revisionId: string,
  occurrenceIds: readonly string[],
) {
  // Bound outside input before SQL, including direct command callers. The
  // shared release validator still owns duplicates, unknown IDs and ancestors.
  if (!Array.isArray(occurrenceIds) || occurrenceIds.length > HOSTED_PLACEMENT_LIMIT)
    throw new InvalidHostedStructureError();
  if (!occurrenceIds.length) return [];
  const descriptor = await hostedAppendDescriptor(client, id, revisionId);
  const rows = (
    await client.query<HostedPlacementRow>(
      `${HOSTED_PLACEMENT_SELECT} AND p.occurrence_id = ANY($4::uuid[]) ORDER BY p.ordinal`,
      [routeOf(id), id, descriptor?.baseRevisionId ?? revisionId, occurrenceIds],
    )
  ).rows;
  const base = rows.map(hostedPlacement);
  if (!descriptor || descriptor.highWater < 0n) return base;
  const appended = await appendRelease.run(client, {
    route: routeOf(id)!,
    catalogue_id: id,
    stream_id: descriptor.baseRevisionId,
    occurrence_ids: [...occurrenceIds],
    high_water: descriptor.highWater.toString(),
  });
  return [...base, ...appended.map((row) => appendedPlacement(row, descriptor))];
}
