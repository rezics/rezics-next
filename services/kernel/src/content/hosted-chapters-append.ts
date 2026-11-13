import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import {
  InvalidHostedStructureError,
  type HostedAppendDescriptor,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';

/** Counts and addresses must survive a future JSON number boundary exactly.
 * bigint arithmetic prevents rounding before the bound is checked. */
export const HOSTED_EXACT_INTEGER_MAX = 9_007_199_254_740_991n;

type DescriptorRow = {
  revision_id: string;
  base_revision_id: string;
  base_placement_count: string;
  base_root_count: string;
  high_water: string;
};

export const HOSTED_APPEND_DESCRIPTOR_SELECT = `SELECT revision_id,base_revision_id,
  base_placement_count::text,base_root_count::text,high_water::text
  FROM content.hosted_append_descriptor
  WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`;

/** These probes use the existing full revision ordinal and root-position keys.
 * Never replace them with COUNT, an aggregate, or a full-outline read. */
export const HOSTED_BASE_PREORDER_MAX = `SELECT ordinal FROM content.hosted_placement
  WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3
  ORDER BY ordinal DESC LIMIT 1`;
export const HOSTED_BASE_ROOT_MAX = `SELECT position FROM content.hosted_placement
  WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3 AND parent_id IS NULL
  ORDER BY position DESC LIMIT 1`;

export async function hostedAppendDescriptor(
  client: AccessClient,
  catalogueId: string,
  revisionId: string,
): Promise<HostedAppendDescriptor | null> {
  const row = (
    await client.query<DescriptorRow>(HOSTED_APPEND_DESCRIPTOR_SELECT, [routeOf(catalogueId), catalogueId, revisionId])
  ).rows[0];
  return row
    ? {
        revisionId: row.revision_id,
        baseRevisionId: row.base_revision_id,
        basePlacementCount: BigInt(row.base_placement_count),
        baseRootCount: BigInt(row.base_root_count),
        highWater: BigInt(row.high_water),
      }
    : null;
}

/** Called only after native admission, receipt lookup and the locked head fence.
 * A legacy head has no descriptor. Seal it lazily without changing its revision,
 * occurrence bindings, placements, publication, or any old receipt. */
export async function sealHostedAppendBase(
  client: AccessClient,
  catalogueId: string,
  revisionId: string,
): Promise<HostedAppendDescriptor> {
  const existing = await hostedAppendDescriptor(client, catalogueId, revisionId);
  if (existing) return existing;
  const parameters = [routeOf(catalogueId), catalogueId, revisionId];
  const ordinal = (await client.query<{ ordinal: number }>(HOSTED_BASE_PREORDER_MAX, parameters)).rows[0];
  const root = (await client.query<{ position: number }>(HOSTED_BASE_ROOT_MAX, parameters)).rows[0];
  const descriptor: HostedAppendDescriptor = {
    revisionId,
    baseRevisionId: revisionId,
    basePlacementCount: ordinal ? BigInt(ordinal.ordinal) + 1n : 0n,
    baseRootCount: root ? BigInt(root.position) + 1n : 0n,
    highWater: -1n,
  };
  await insertDescriptor(client, catalogueId, descriptor);
  return descriptor;
}

/** The next count, rather than only the next ordinal, must remain exact. A draft
 * at MAX_SAFE_INTEGER placements cannot admit another row. No offset is spent
 * on rejection; all inserts belong to the ordinary command transaction. */
export function nextHostedAppend(descriptor: HostedAppendDescriptor) {
  const offset = descriptor.highWater + 1n;
  const ordinal = descriptor.basePlacementCount + offset;
  const position = descriptor.baseRootCount + offset;
  if (ordinal >= HOSTED_EXACT_INTEGER_MAX || position >= HOSTED_EXACT_INTEGER_MAX)
    throw new InvalidHostedStructureError('Hosted structure exceeds exact integer capacity');
  return { offset, ordinal, position };
}

async function insertDescriptor(client: AccessClient, catalogueId: string, descriptor: HostedAppendDescriptor) {
  await client.query(
    `INSERT INTO content.hosted_append_descriptor
     (route,catalogue_id,revision_id,base_revision_id,base_placement_count,base_root_count,high_water)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      routeOf(catalogueId),
      catalogueId,
      descriptor.revisionId,
      descriptor.baseRevisionId,
      descriptor.basePlacementCount.toString(),
      descriptor.baseRootCount.toString(),
      descriptor.highWater.toString(),
    ],
  );
}

/** The caller holds the catalogue row through commit and has already checked
 * expectedRevisionId. No earlier target, tree, sibling or revision is read.
 * A stream's identity is its sealed base revision, never the preceding draft. */
export async function insertHostedRootAppend(
  client: AccessClient,
  catalogueId: string,
  expectedRevisionId: string,
  revisionId: string,
  chapter: Extract<OrderedHostedPlacement, { kind: 'chapter' }>,
): Promise<void> {
  const descriptor = await sealHostedAppendBase(client, catalogueId, expectedRevisionId);
  const { offset } = nextHostedAppend(descriptor);
  const route = routeOf(catalogueId);
  const occurrence = await client.query(
    `INSERT INTO content.hosted_occurrence(route,catalogue_id,occurrence_id,kind,thread_id,post_id)
     VALUES ($1,$2,$3,'chapter',$4,$5)
     ON CONFLICT (route,catalogue_id,occurrence_id) DO NOTHING RETURNING occurrence_id`,
    [route, catalogueId, chapter.occurrenceId, chapter.target.threadId, chapter.target.postId],
  );
  // An append requires a fresh occurrence even when an older occurrence had the
  // same Post. Duplicate targets remain possible under distinct fresh IDs.
  if (!occurrence.rows.length) throw new InvalidHostedStructureError('Occurrence identity cannot be reused');
  await client.query(
    `INSERT INTO content.hosted_append
     (route,catalogue_id,stream_id,append_offset,revision_id,occurrence_id,title,target_revision_id,body_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,decode($9,'hex'))`,
    [
      route,
      catalogueId,
      descriptor.baseRevisionId,
      offset.toString(),
      revisionId,
      chapter.occurrenceId,
      chapter.title,
      chapter.target.revisionId,
      chapter.target.sha256,
    ],
  );
  await insertDescriptor(client, catalogueId, { ...descriptor, revisionId, highWater: offset });
}
