import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { HostedAppendDescriptor } from './hosted-chapters-model.ts';

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

/** Read-only existing-data input for one-time maintenance; public authoring uses the ordered owner. */
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
