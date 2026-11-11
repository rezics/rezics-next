import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { InvalidHostedStructureError, type OrderedHostedPlacement } from './hosted-chapters-model.ts';

export type HostedCatalogueRow = {
  route: number;
  catalogue_id: string;
  thread_id: string;
  head_revision_id: string;
  publication_id: string | null;
};
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
  return (await client.query<HostedCatalogueRow>(
    `SELECT route,catalogue_id,thread_id,head_revision_id,publication_id
     FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [routeOf(id), id],
  )).rows[0] ?? null;
}
export async function hostedRevision(client: AccessClient, id: string, revisionId: string) {
  return (await client.query<HostedRevisionRow>(
    `SELECT revision_id,kind,source_revision_id FROM content.hosted_structure_revision
     WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`, [routeOf(id), id, revisionId],
  )).rows[0] ?? null;
}
export function hostedPlacement(row: HostedPlacementRow): OrderedHostedPlacement {
  const base = {
    occurrenceId: row.occurrence_id, parentId: row.parent_id, position: row.position,
    ordinal: row.ordinal, title: row.title,
  };
  if (row.kind === 'part') return { ...base, kind: 'part' };
  if (!row.thread_id || !row.post_id || !row.target_revision_id || !row.sha256)
    throw new Error('Invalid hosted chapter binding');
  return { ...base, kind: 'chapter', target: {
    threadId: row.thread_id, postId: row.post_id, revisionId: row.target_revision_id, sha256: row.sha256,
  } };
}
export async function hostedPlacements(client: AccessClient, id: string, revisionId: string) {
  const rows = (await client.query<HostedPlacementRow>(
    `${HOSTED_PLACEMENT_SELECT} ORDER BY p.ordinal LIMIT 513`, [routeOf(id), id, revisionId],
  )).rows;
  if (rows.length > 512) throw new Error('Hosted structure exceeds its storage bound');
  return rows.map(hostedPlacement);
}

/** One bounded insert per relation; immutable identities are checked before adding revision rows. */
export async function insertHostedPlacements(
  client: AccessClient, id: string, revisionId: string, placements: readonly OrderedHostedPlacement[],
): Promise<void> {
  if (!placements.length) return;
  const route = routeOf(id);
  const input = JSON.stringify(placements.map((placement) => ({
    occurrence_id: placement.occurrenceId, parent_id: placement.parentId, position: placement.position,
    ordinal: placement.ordinal, title: placement.title, kind: placement.kind,
    thread_id: placement.target?.threadId ?? null, post_id: placement.target?.postId ?? null,
    target_revision_id: placement.target?.revisionId ?? null, sha256: placement.target?.sha256 ?? null,
  })));
  await client.query(
    `INSERT INTO content.hosted_occurrence(route,catalogue_id,occurrence_id,kind,thread_id,post_id)
     SELECT $1,$2,x.occurrence_id,x.kind,x.thread_id,x.post_id
     FROM jsonb_to_recordset($3::jsonb) AS x(occurrence_id uuid,kind text,thread_id uuid,post_id uuid)
     ON CONFLICT (route,catalogue_id,occurrence_id) DO NOTHING`, [route, id, input],
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
       title text,target_revision_id uuid,sha256 text)`, [route, id, revisionId, input],
  );
}
