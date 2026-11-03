import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf } from '../route/route.ts';
import {
  dependencyPageLimit,
  SPACE_DISCOVERY_DEPENDENCY_BASIS as basis,
  SPACE_DISCOVERY_DEPENDENCY_PAGE,
} from './space-discovery-dependencies.ts';
import { SPACE_DISCOVERY_INVALIDATED, SpaceDiscoveryInvalidation } from './space-discovery-events.ts';

export type SpaceDiscoveryFrontier = Readonly<{ partition: number; obligation: string }>;
export type SpaceDiscoveryFrontierState = 'preparing' | 'unavailable' | 'draining' | 'settled';
export type SpaceDiscoveryFrontierProgress = Readonly<{
  state: SpaceDiscoveryFrontierState;
  cursor: string;
  cut: string | null;
  examined: string;
}>;
type Progress = {
  invalidation: SpaceDiscoveryInvalidation;
  state: SpaceDiscoveryFrontierState;
  cursor: string;
  cut: string | null;
};

/** Consumer acknowledgement reads the native ledger, not a completed relay
 * workflow or an expired command receipt. Decimal progress stays lossless.
 */
export function readSpaceDiscoveryFrontier(
  pool: Pool,
  key: SpaceDiscoveryFrontier,
): Promise<SpaceDiscoveryFrontierProgress | null> {
  return withConnection(pool, async (client) => {
    const row = (
      await client.query<SpaceDiscoveryFrontierProgress>(
        `SELECT state,cursor::text,cut::text,examined::text
         FROM community.space_discovery_frontier WHERE partition_no=$1 AND obligation=$2`,
        [key.partition, key.obligation],
      )
    ).rows[0];
    return row ?? null;
  });
}

/** The original native tuple and target identify the obligation. Delivery log
 * positions, clocks and receipt lifetimes never replace this identity.
 */
export function spaceDiscoveryObligation(invalidation: SpaceDiscoveryInvalidation): string {
  return createHash('sha256').update(canonicalize(invalidation)!).digest('hex');
}

export async function openSpaceDiscoveryFrontier(
  pool: Pool,
  event: CloudEvent,
): Promise<SpaceDiscoveryFrontier | null> {
  if (event.type !== SPACE_DISCOVERY_INVALIDATED) throw new TypeError('Expected native Space invalidation');
  if (!Value.Check(SpaceDiscoveryInvalidation, event.data)) throw new TypeError('Invalid Space scope obligation');
  const invalidation = event.data;
  if (invalidation.target.kind === 'space') return null;
  const key = { partition: invalidation.origin.partition, obligation: spaceDiscoveryObligation(invalidation) };
  // The delivered native contracts supply Context and selected avatar identities.
  // Search's native routes declare search/search_advanced exposure dependencies.
  // No producer currently supplies an imported Space source tuple. Keep that
  // obligation explicit until the native capability connects.
  const supported = invalidation.target.kind !== 'source-fence';
  await runCommand(pool, { partition: key.partition, basis }, async (tx) => {
    await tx.query(
      `INSERT INTO community.space_discovery_frontier(partition_no,obligation,invalidation,state)
       VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
      [key.partition, key.obligation, JSON.stringify(invalidation), supported ? 'preparing' : 'unavailable'],
    );
    return noEffect(null);
  });
  return key;
}

async function prepareFrontier(pool: Pool, key: SpaceDiscoveryFrontier): Promise<Progress> {
  const result = await runCommand(pool, { partition: key.partition, basis }, async (tx) => {
    const row = (
      await tx.query<Progress>(
        `SELECT invalidation,state,cursor::text,cut::text FROM community.space_discovery_frontier
         WHERE partition_no=$1 AND obligation=$2 FOR UPDATE`,
        [key.partition, key.obligation],
      )
    ).rows[0];
    if (!row) throw new Error('Space discovery obligation unavailable');
    if (row.state !== 'preparing') return noEffect(row);
    const pending = await tx.query(
      `SELECT partition_no FROM community.space_discovery_dependency_install
       WHERE NOT complete ORDER BY partition_no LIMIT 1`,
    );
    if (pending.rows.length) return noEffect(row);
    const cut = (
      await tx.query<{ cut: string }>(
        `SELECT COALESCE((SELECT ordinal FROM community.space_discovery_dependency
         WHERE dependency=$1::jsonb ORDER BY ordinal DESC LIMIT 1),0)::text AS cut`,
        [JSON.stringify(row.invalidation.target)],
      )
    ).rows[0]!.cut;
    await tx.query(
      `UPDATE community.space_discovery_frontier SET state='draining',cut=$3
       WHERE partition_no=$1 AND obligation=$2`,
      [key.partition, key.obligation, cut],
    );
    return noEffect({ ...row, state: 'draining' as const, cut });
  });
  return result.value;
}

/** One exact Space command, released before any frontier acknowledgement. The
 * retained dedup row and canonical event share its native publication commit.
 * No public facts or old permission claims are copied into the wake.
 */
async function wakeSpace(
  pool: Pool,
  obligation: string,
  invalidation: SpaceDiscoveryInvalidation,
  space: Readonly<{ route: number; space_id: string }>,
): Promise<void> {
  await runCommand(pool, { partition: partitionOf(space.route), basis }, async (tx) => {
    const retained = await tx.query(
      'SELECT space_id FROM community.space WHERE route=$1 AND space_id=$2 FOR KEY SHARE',
      [space.route, space.space_id],
    );
    if (!retained.rows.length) return noEffect(null);
    const inserted = await tx.query(
      `INSERT INTO community.space_discovery_frontier_wake(route,space_id,obligation)
       VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING space_id`,
      [space.route, space.space_id, obligation],
    );
    if (!inserted.rows.length) return noEffect(null);
    return {
      value: null,
      events: [{
        type: SPACE_DISCOVERY_INVALIDATED,
        subject: space.space_id,
        data: { ...invalidation, target: { kind: 'space', id: space.space_id } },
      }],
    };
  });
}

/** A bounded raw inverse page, including removed/protected owners. Empty public
 * pages never participate. A crash after a wake repeats only its retained dedup
 * lookup; the durable cursor moves only after every examined key is delivered.
 */
export async function drainSpaceDiscoveryFrontier(
  pool: Pool,
  key: SpaceDiscoveryFrontier,
  limit = SPACE_DISCOVERY_DEPENDENCY_PAGE,
): Promise<SpaceDiscoveryFrontierState> {
  dependencyPageLimit(limit);
  const progress = await prepareFrontier(pool, key);
  if (progress.state !== 'draining') return progress.state;
  const page = await withConnection(pool, async (client) => (
    await client.query<{ route: number; space_id: string; ordinal: string }>(
      `SELECT d.route,d.space_id,d.ordinal::text FROM community.space_discovery_dependency d
       WHERE d.dependency=$1::jsonb AND d.ordinal>$2::bigint AND d.ordinal<=$3::bigint
       ORDER BY d.ordinal LIMIT $4`,
      [JSON.stringify(progress.invalidation.target), progress.cursor, progress.cut, limit],
    )
  ).rows);
  for (const space of page) await wakeSpace(pool, key.obligation, progress.invalidation, space);
  const settled = page.length < limit;
  const cursor = settled ? progress.cut! : page.at(-1)!.ordinal;
  const result = await runCommand(pool, { partition: key.partition, basis }, async (tx) => {
    await tx.query(
      `UPDATE community.space_discovery_frontier SET cursor=$4,examined=examined+$5,state=$6
       WHERE partition_no=$1 AND obligation=$2 AND cursor=$3::bigint AND state='draining'`,
      [key.partition, key.obligation, progress.cursor, cursor, page.length, settled ? 'settled' : 'draining'],
    );
    const row = (
      await tx.query<{ state: SpaceDiscoveryFrontierState }>(
        `SELECT state FROM community.space_discovery_frontier WHERE partition_no=$1 AND obligation=$2`,
        [key.partition, key.obligation],
      )
    ).rows[0];
    if (!row) throw new Error('Space discovery obligation unavailable');
    return noEffect(row.state);
  });
  return result.value;
}

/** Startup/periodic recovery uses the pending-work index. Only locators cross
 * workflow boundaries; native cursors and deduplication never live in DBOS.
 */
export function pendingSpaceDiscoveryFrontiers(pool: Pool): Promise<readonly SpaceDiscoveryFrontier[]> {
  return withConnection(pool, async (client) => (
    await client.query<SpaceDiscoveryFrontier>(
      `SELECT partition_no AS partition,obligation FROM community.space_discovery_frontier
       WHERE state IN ('preparing','draining') ORDER BY partition_no,obligation LIMIT 50`,
    )
  ).rows);
}
