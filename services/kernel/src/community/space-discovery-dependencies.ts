import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { PARTITIONS } from '../route/route.ts';

export const SPACE_DISCOVERY_DEPENDENCY_PAGE = 50;
export const SPACE_DISCOVERY_DEPENDENCY_BASIS = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-community',
  requestedBy: null,
};

export type SpaceDiscoveryDependencyReadiness = Readonly<{
  state: 'preparing' | 'unavailable';
  capabilities: Readonly<{
    context: 'connected';
    media: 'connected';
    exposure: 'connected';
    'source-fence': 'unavailable';
  }>;
}>;

/** Registration must use explicit producer capability, never infer readiness
 * from an empty eligible page or the absence of outstanding scope obligations.
 * This contract deliberately cannot report ready before a native tuple owner
 * connects; bootstrap/current hydration remain independently usable.
 */
export async function spaceDiscoveryDependencyReadiness(pool: Pool): Promise<SpaceDiscoveryDependencyReadiness> {
  const installing = await nextSpaceDiscoveryDependencyInstall(pool);
  return {
    state: installing === null ? 'unavailable' : 'preparing',
    capabilities: {
      context: 'connected',
      media: 'connected',
      exposure: 'connected',
      'source-fence': 'unavailable',
    },
  };
}

export function dependencyPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > SPACE_DISCOVERY_DEPENDENCY_PAGE)
    throw new RangeError('Space dependency page limit must be 1..50');
}

/** The deployment census is independent of eligibility. Native deferred writer
 * triggers maintain changes on both sides of the captured installation cut.
 * A page locks each exact retained owner before reading its current Realm head.
 */
export async function initializeSpaceDiscoveryDependencies(
  pool: Pool,
  partition: number,
  limit = SPACE_DISCOVERY_DEPENDENCY_PAGE,
): Promise<boolean> {
  dependencyPageLimit(limit);
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Invalid Space dependency partition');
  const result = await runCommand(pool, { partition, basis: SPACE_DISCOVERY_DEPENDENCY_BASIS }, async (tx) => {
    const row = (
      await tx.query<{
        cursor_route: number;
        cursor_id: string;
        cut_route: number;
        cut_id: string;
        complete: boolean;
      }>(
        `SELECT cursor_route,cursor_id,cut_route,cut_id,complete
           FROM community.space_discovery_dependency_install WHERE partition_no=$1 FOR UPDATE`,
        [partition],
      )
    ).rows[0];
    if (!row) throw new Error('Space dependency installation unavailable');
    if (row.complete) return noEffect(false);
    const page = (
      await tx.query<{ route: number; space_id: string }>(
        `SELECT route,space_id FROM community.space
           WHERE route BETWEEN $1 AND $2 AND (route,space_id)>($3,$4::uuid)
             AND (route,space_id)<=($5,$6::uuid) ORDER BY route,space_id LIMIT $7`,
        [partition * 16, partition * 16 + 15, row.cursor_route, row.cursor_id, row.cut_route, row.cut_id, limit],
      )
    ).rows;
    for (const key of page)
      await tx.query('SELECT community.refresh_space_discovery_dependencies($1,$2::uuid)', [key.route, key.space_id]);
    const last = page.at(-1);
    await tx.query(
      `UPDATE community.space_discovery_dependency_install
         SET cursor_route=$2,cursor_id=$3,complete=$4 WHERE partition_no=$1`,
      [partition, last?.route ?? row.cut_route, last?.space_id ?? row.cut_id, page.length < limit],
    );
    return noEffect(page.length === limit);
  });
  return result.value;
}

/** Only the indexed unfinished installation keys are visited by maintenance;
 * a scope never enumerates the 4096 partitions, even when its inverse is empty.
 */
export function nextSpaceDiscoveryDependencyInstall(pool: Pool): Promise<number | null> {
  return withConnection(pool, async (client) => {
    const row = (
      await client.query<{ partition_no: number }>(
        `SELECT partition_no FROM community.space_discovery_dependency_install
         WHERE NOT complete ORDER BY partition_no LIMIT 1`,
      )
    ).rows[0];
    return row?.partition_no ?? null;
  });
}
