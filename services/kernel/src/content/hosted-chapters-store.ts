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

export type HostedCatalogueRow = {
  route: number;
  catalogue_id: string;
  thread_id: string;
  head_revision_id: string;
  publication_id: string | null;
};
export type HostedOwnedCatalogueRow = HostedCatalogueRow & { created_at: string };

// Ownership belongs to the anchor Post, not to a structure revision's creator,
// a placement target, or a possibly delayed author-item projection.
const HOSTED_OWNED_SELECT = `
  SELECT c.route,c.catalogue_id,c.thread_id,c.head_revision_id,c.publication_id,
    to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
  FROM content.hosted_catalogue c
  JOIN content.post p ON p.route=c.route AND p.thread_id=c.thread_id AND p.post_id=c.catalogue_id
  WHERE c.route=$1 AND p.author_account_id=$2
    AND p.availability='available' AND NOT p.author_erased
    AND p.visibility IN ('draft','published','protected')`;

/** One explicit source route; never enumerate partitions or treat the author
 * locator as proof of hosted membership. Exact microseconds survive the cursor. */
export async function hostedOwnedCataloguePage(
  client: AccessClient,
  route: number,
  accountId: string,
  after: Readonly<{ createdAt: string; itemId: string }> | null,
  limit: number,
) {
  if (
    routeOf(accountId) !== route ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > HOSTED_PAGE_LIMIT + 1 ||
    (after !== null && routeOf(after.itemId) !== route)
  )
    throw new InvalidHostedStructureError();
  return (
    await client.query<HostedOwnedCatalogueRow>(
      `${HOSTED_OWNED_SELECT}
     AND ($3::timestamptz IS NULL OR p.created_at<$3::timestamptz
       OR (p.created_at=$3::timestamptz AND c.catalogue_id>$4::uuid))
     ORDER BY p.created_at DESC,c.catalogue_id ASC LIMIT $5`,
      [route, accountId, after?.createdAt ?? null, after?.itemId ?? null, limit],
    )
  ).rows;
}

export async function hostedOwnedCatalogue(client: AccessClient, route: number, accountId: string, id: string) {
  if (routeOf(id) !== route) throw new InvalidHostedStructureError();
  return (
    (
      await client.query<HostedOwnedCatalogueRow>(`${HOSTED_OWNED_SELECT} AND c.catalogue_id=$3`, [
        route,
        accountId,
        id,
      ])
    ).rows[0] ?? null
  );
}
export type HostedRevisionRow = {
  revision_id: string;
  kind: 'structure' | 'publication';
  source_revision_id: string | null;
};
export type HostedPlacementRow = {
  occurrence_id: string;
  parent_id: string | null;
  position: number;
  ordinal: number;
  title: string;
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

export async function hostedCatalogue(client: AccessClient, id: string, lock = false) {
  return (
    (
      await client.query<HostedCatalogueRow>(
        `SELECT route,catalogue_id,thread_id,head_revision_id,publication_id
     FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [routeOf(id), id],
      )
    ).rows[0] ?? null
  );
}
export async function hostedRevision(client: AccessClient, id: string, revisionId: string) {
  return (
    (
      await client.query<HostedRevisionRow>(
        `SELECT revision_id,kind,source_revision_id FROM content.hosted_structure_revision
     WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`,
        [routeOf(id), id, revisionId],
      )
    ).rows[0] ?? null
  );
}
export function hostedPlacement(row: HostedPlacementRow): OrderedHostedPlacement {
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
  title: string;
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

/** One bounded insert per relation; immutable identities are checked before adding revision rows. */
export async function insertHostedPlacements(
  client: AccessClient,
  id: string,
  revisionId: string,
  placements: readonly OrderedHostedPlacement[],
): Promise<void> {
  if (!placements.length) return;
  const route = routeOf(id);
  const input = JSON.stringify(
    placements.map((placement) => ({
      occurrence_id: placement.occurrenceId,
      parent_id: placement.parentId,
      position: placement.position,
      ordinal: placement.ordinal,
      title: placement.title,
      kind: placement.kind,
      thread_id: placement.target?.threadId ?? null,
      post_id: placement.target?.postId ?? null,
      target_revision_id: placement.target?.revisionId ?? null,
      sha256: placement.target?.sha256 ?? null,
    })),
  );
  await client.query(
    `INSERT INTO content.hosted_occurrence(route,catalogue_id,occurrence_id,kind,thread_id,post_id)
     SELECT $1,$2,x.occurrence_id,x.kind,x.thread_id,x.post_id
     FROM jsonb_to_recordset($3::jsonb) AS x(occurrence_id uuid,kind text,thread_id uuid,post_id uuid)
     ON CONFLICT (route,catalogue_id,occurrence_id) DO NOTHING`,
    [route, id, input],
  );
  const conflict = await client.query(
    `SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS x(occurrence_id uuid,kind text,thread_id uuid,post_id uuid)
     JOIN content.hosted_occurrence o ON o.route=$1 AND o.catalogue_id=$2 AND o.occurrence_id=x.occurrence_id
     WHERE ROW(o.kind,o.thread_id,o.post_id) IS DISTINCT FROM ROW(x.kind,x.thread_id,x.post_id) LIMIT 1`,
    [route, id, input],
  );
  if (conflict.rows.length) throw new InvalidHostedStructureError('Occurrence identity cannot be reused');
  await client.query(
    `INSERT INTO content.hosted_placement
       (route,catalogue_id,revision_id,occurrence_id,parent_id,position,ordinal,title,target_revision_id,body_sha256)
     SELECT $1,$2,$3,x.occurrence_id,x.parent_id,x.position,x.ordinal,x.title,x.target_revision_id,decode(x.sha256,'hex')
     FROM jsonb_to_recordset($4::jsonb) AS x(occurrence_id uuid,parent_id uuid,position integer,ordinal integer,
       title text,target_revision_id uuid,sha256 text)`,
    [route, id, revisionId, input],
  );
}
