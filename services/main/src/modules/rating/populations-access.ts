import type { Pool } from 'pg';
import { controlRead } from '../access/topology-control.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';

export interface PopulationInheritance {
  context: string;
  observation: string;
  origin: string;
  revision: string;
}
/** Exact target-leading inventory. Native person votes take precedence over
 * inherited votes, including withdrawals. Identities stay behind the owner. */
export class RatingPopulationsStore {
  constructor(private readonly pool: Pool) {}
  inherited(mainVersion: string): Promise<PopulationInheritance[]> {
    return controlRead(this.pool, async (client) => {
      const rows = (
        await client.query<PopulationInheritance>(
          `SELECT s.context, h.observation,
          h.work AS origin, h.revision FROM access.rating_merge_selection s
        JOIN access.rating_aggregate_head h ON h.context=s.context AND h.main_version=s.origin_main_version
          AND h.slot=s.origin_slot AND h.principal_id=s.principal_id AND h.target_release IS NULL
        WHERE s.main_version=$1 AND NOT EXISTS (SELECT 1 FROM access.rating_aggregate_head native
          WHERE native.context=s.context AND native.main_version=s.main_version
            AND native.principal_id=s.principal_id AND native.target_release IS NULL)
        ORDER BY s.context,s.principal_id LIMIT 4097`,
          [mainVersion],
        )
      ).rows;
      if (rows.length > 4096)
        throw new WorkReadUnavailable('Inherited rating inventory exceeds its read budget');
      return rows;
    });
  }
}
