import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import {
  HOSTED_PAGE_LIMIT,
  InvalidHostedStructureError,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';

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
/** Permanent occurrence identity is independent of its selected outline, title and exact body revision. */
export async function ensureHostedOccurrenceIdentities(
  client: AccessClient,
  id: string,
  placements: readonly OrderedHostedPlacement[],
): Promise<void> {
  if (!placements.length) return;
  const route = routeOf(id);
  const input = JSON.stringify(
    placements.map((placement) => ({
      occurrence_id: placement.occurrenceId,
      kind: placement.kind,
      thread_id: placement.target?.threadId ?? null,
      post_id: placement.target?.postId ?? null,
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
}
