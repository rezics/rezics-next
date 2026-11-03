import { createHash } from 'node:crypto';
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

type SourceFenceCapability = 'preparing' | 'unavailable' | 'connected';
type DependencyCapabilities<T extends SourceFenceCapability> = Readonly<{
  context: 'connected';
  media: 'connected';
  exposure: 'connected';
  'source-fence': T;
}>;

export type SpaceDiscoveryDependencyReadiness =
  | Readonly<{
      state: 'preparing';
      generation?: string;
      cut?: string | null;
      capabilities: DependencyCapabilities<'preparing' | 'unavailable'>;
    }>
  | Readonly<{
      state: 'unavailable';
      generation?: string;
      cut?: string | null;
      reason?: 'source-tuple-producer-missing' | 'source-tuple-coverage-incomplete';
      capabilities: DependencyCapabilities<'unavailable'>;
    }>
  | Readonly<{
      state: 'ready';
      generation: string;
      cut: string;
      capabilities: DependencyCapabilities<'connected'>;
    }>;

/** A ready result is issued only for an explicit source census plus a current
 * exact witness for every retained Space. Empty pages and empty inverse ranges
 * never supply either proof. Generation/cut are opaque equality witnesses over
 * the captured native installation and the current tuple coverage frontier.
 */
export async function spaceDiscoveryDependencyReadiness(pool: Pool): Promise<SpaceDiscoveryDependencyReadiness> {
  const observation = await withConnection(pool, async (client) => {
    const row = (
      await client.query<{
        pending_install: string;
        install_cut: string | null;
        tuple_generation: string | null;
        tuple_cut: string | null;
        required: string;
        witnessed: string;
        pending: string;
        producer_generation: string | null;
        producer_cut: string | null;
        producer_complete: boolean | null;
      }>(
        `WITH installation AS MATERIALIZED (
           SELECT COUNT(*) FILTER (WHERE NOT complete)::text AS pending_install,
                  md5(string_agg(partition_no::text||':'||cursor_route::text||':'||cursor_id::text||':'||
                    cut_route::text||':'||cut_id::text||':'||complete::text,'|' ORDER BY partition_no)) AS install_cut
           FROM community.space_discovery_dependency_install
         ), tuple_coverage AS MATERIALIZED (
           SELECT md5(string_agg(partition_no::text||':'||generation::text,'|' ORDER BY partition_no)) AS tuple_generation,
                  md5(string_agg(partition_no::text||':'||cut::text||':'||required::text||':'||
                    witnessed::text||':'||pending::text,'|' ORDER BY partition_no)) AS tuple_cut,
                  COALESCE(SUM(required),0)::text AS required,
                  COALESCE(SUM(witnessed),0)::text AS witnessed,
                  COALESCE(SUM(pending),0)::text AS pending
           FROM community.space_discovery_tuple_capability
         ), producer AS MATERIALIZED (
           SELECT generation AS producer_generation,cut AS producer_cut,complete AS producer_complete
           FROM community.space_discovery_tuple_producer WHERE singleton=true
         )
         SELECT installation.pending_install,installation.install_cut,
                tuple_coverage.tuple_generation,tuple_coverage.tuple_cut,
                tuple_coverage.required,tuple_coverage.witnessed,tuple_coverage.pending,
                producer.producer_generation,producer.producer_cut,producer.producer_complete
         FROM installation CROSS JOIN tuple_coverage LEFT JOIN producer ON true`,
      )
    ).rows[0]!;
    return row;
  });
  const generation = createHash('sha256')
    .update(`${observation.install_cut ?? 'missing'}:${observation.tuple_generation ?? 'missing'}:${observation.producer_generation ?? 'missing'}`)
    .digest('hex');
  const cut = createHash('sha256')
    .update(`${observation.install_cut ?? 'missing'}:${observation.tuple_cut ?? 'missing'}:${observation.producer_cut ?? 'missing'}`)
    .digest('hex');
  const capabilities = <T extends SourceFenceCapability>(sourceFence: T): DependencyCapabilities<T> => ({
    context: 'connected' as const,
    media: 'connected' as const,
    exposure: 'connected' as const,
    'source-fence': sourceFence,
  });
  if (BigInt(observation.pending_install) > 0n)
    return { state: 'preparing', generation, cut, capabilities: capabilities('preparing') };
  if (!observation.producer_complete)
    return {
      state: 'unavailable',
      generation,
      cut,
      reason: 'source-tuple-producer-missing',
      capabilities: capabilities('unavailable'),
    };
  if (BigInt(observation.pending) > 0n)
    return { state: 'preparing', generation, cut, capabilities: capabilities('preparing') };
  if (observation.required !== observation.witnessed)
    return {
      state: 'unavailable',
      generation,
      cut,
      reason: 'source-tuple-coverage-incomplete',
      capabilities: capabilities('unavailable'),
    };
  return { state: 'ready', generation, cut, capabilities: capabilities('connected') };
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
