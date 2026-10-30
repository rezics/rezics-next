import type { Pool } from 'pg';
import { authoritativeTimeValue, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import type { DiscoverySourceFact } from '../content/discovery.ts';
import { routeOf } from '../route/route.ts';
import { readRealmDiscoveryChanges, type RealmDiscoveryCommittedChange } from './discovery-source.ts';
import {
  addDiscoveryDay,
  dayAfter,
  DISCOVERY_APPLIED,
  DISCOVERY_PARTITION,
  discoverySnapshot,
  queueDiscoveryDue,
  refreshDiscoveryTotals,
  stateColumns,
  type DiscoveryState,
} from './discovery-projection-store.ts';

const ZERO_DAY = '1970-01-01';
function unavailable(): never {
  throw new Error('Realm discovery source unavailable');
}
function generation(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) unavailable();
  return BigInt(value);
}
function version(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) unavailable();
}
function retained(day: string, cutoff: string): boolean {
  return day >= dayAfter(cutoff, -30) && day <= cutoff;
}

type CachedThread = {
  board_id: string;
  space_id: string;
  source_route: number;
  creation_day: string;
  source_version: string;
  contributing: boolean;
};
async function thread(
  tx: CommandTransaction,
  record: RealmDiscoveryCommittedChange,
  source: DiscoverySourceFact,
  cutoff: string,
) {
  version(source.sourceVersion);
  if (
    source.realmId !== record.realmId ||
    source.realmEpoch !== record.realmEpoch ||
    routeOf(source.threadId) !== source.sourceRoute ||
    routeOf(source.boardId) === null ||
    routeOf(source.spaceId) === null ||
    !/^\d{4}-\d\d-\d\d$/.test(source.creationDay) ||
    !Number.isFinite(Date.parse(`${source.creationDay}T00:00:00Z`)) ||
    new Date(`${source.creationDay}T00:00:00Z`).toISOString().slice(0, 10) !== source.creationDay ||
    typeof source.contributing !== 'boolean' ||
    source.creationDay > cutoff
  )
    unavailable();
  // Ancient restorations never acquire a new day or revive an expired bucket.
  if (!retained(source.creationDay, cutoff)) return;
  const key = [record.realmId, record.realmEpoch, source.threadId];
  const old = (
    await tx.query<CachedThread>(
      `SELECT board_id,space_id,source_route,creation_day::text,source_version,contributing
    FROM community.discovery_thread WHERE route=0 AND realm_id=$1 AND realm_epoch=$2 AND thread_id=$3`,
      key,
    )
  ).rows[0];
  if (
    old &&
    (old.board_id !== source.boardId ||
      old.space_id !== source.spaceId ||
      old.source_route !== source.sourceRoute ||
      old.creation_day !== source.creationDay)
  )
    unavailable();
  if (old?.source_version === source.sourceVersion) {
    if (old.contributing !== source.contributing) unavailable();
    return;
  }
  const change = BigInt(Number(source.contributing) - Number(old?.contributing ?? false));
  await tx.query(
    `INSERT INTO community.discovery_thread
    (route,realm_id,realm_epoch,thread_id,board_id,space_id,source_route,creation_day,source_version,contributing)
    VALUES(0,$1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(route,realm_id,realm_epoch,thread_id)
    DO UPDATE SET source_version=EXCLUDED.source_version,contributing=EXCLUDED.contributing`,
    [
      ...key,
      source.boardId,
      source.spaceId,
      source.sourceRoute,
      source.creationDay,
      source.sourceVersion,
      source.contributing,
    ],
  );
  const bucket = [record.realmId, record.realmEpoch, source.boardId, source.creationDay, change.toString()];
  if (change < 0n) {
    const result = await tx.query(
      `UPDATE community.discovery_bucket SET count=count+$5::bigint
      WHERE route=0 AND realm_id=$1 AND realm_epoch=$2 AND board_id=$3 AND creation_day=$4 RETURNING count`,
      bucket,
    );
    if (result.rowCount !== 1) unavailable();
  } else if (change > 0n) {
    await tx.query(
      `INSERT INTO community.discovery_bucket(route,realm_id,realm_epoch,board_id,creation_day,count)
      VALUES(0,$1,$2,$3,$4,$5) ON CONFLICT(route,realm_id,realm_epoch,board_id,creation_day)
      DO UPDATE SET count=community.discovery_bucket.count+$5::bigint`,
      bucket,
    );
  }
  const board = (
    await tx.query<{ published: boolean }>(
      `SELECT published FROM community.discovery_board
    WHERE route=0 AND realm_id=$1 AND realm_epoch=$2 AND board_id=$3`,
      [record.realmId, record.realmEpoch, source.boardId],
    )
  ).rows[0];
  // Original qualification proves the board was published. An explicit later board
  // fact overrides that baseline even when it arrives before this thread fact.
  if (board?.published ?? true) await addDiscoveryDay(tx, record.realmId, source.creationDay, change);
  const expires = `${dayAfter(source.creationDay, 31)}T00:00:00Z`;
  await queueDiscoveryDue(
    tx,
    'thread',
    record.realmId,
    record.realmEpoch,
    source.threadId,
    source.creationDay,
    expires,
  );
  await queueDiscoveryDue(tx, 'bucket', record.realmId, record.realmEpoch, source.boardId, source.creationDay, expires);
}

async function board(tx: CommandTransaction, record: RealmDiscoveryCommittedChange, cutoff: string) {
  if (record.value.kind !== 'board') return;
  const value = record.value;
  version(value.sourceVersion);
  if (routeOf(value.boardId) === null || typeof value.published !== 'boolean') unavailable();
  const key = [record.realmId, record.realmEpoch, value.boardId];
  const old = (
    await tx.query<{ source_version: string; published: boolean }>(
      `SELECT source_version,published
    FROM community.discovery_board WHERE route=0 AND realm_id=$1 AND realm_epoch=$2 AND board_id=$3`,
      key,
    )
  ).rows[0];
  if (old?.source_version === value.sourceVersion) {
    if (old.published !== value.published) unavailable();
    return;
  }
  if ((old?.published ?? true) !== value.published) {
    const buckets = (
      await tx.query<{ creation_day: string; count: string }>(
        `SELECT creation_day::text,count::text
      FROM community.discovery_bucket WHERE route=0 AND realm_id=$1 AND realm_epoch=$2 AND board_id=$3
      AND creation_day >= $4::date-30 AND creation_day <= $4::date ORDER BY creation_day LIMIT 31`,
        [...key, cutoff],
      )
    ).rows;
    for (const bucket of buckets)
      await addDiscoveryDay(
        tx,
        record.realmId,
        bucket.creation_day,
        BigInt(bucket.count) * (value.published ? 1n : -1n),
      );
  }
  await tx.query(
    `INSERT INTO community.discovery_board(route,realm_id,realm_epoch,board_id,source_version,published)
    VALUES(0,$1,$2,$3,$4,$5) ON CONFLICT(route,realm_id,realm_epoch,board_id)
    DO UPDATE SET source_version=EXCLUDED.source_version,published=EXCLUDED.published`,
    [...key, value.sourceVersion, value.published],
  );
  // Old-epoch board gates are deleted through their own indexed due key.
  await queueDiscoveryDue(
    tx,
    'board',
    record.realmId,
    record.realmEpoch,
    value.boardId,
    ZERO_DAY,
    `${dayAfter(cutoff, 31)}T00:00:00Z`,
  );
}

/** No exported record-apply port: only this module's genuine pool reader can supply committed facts. */
export async function projectRealmDiscovery(
  pool: Pool,
  realmId: string,
  options: { clock?: () => Date; deadline?: number } = {},
): Promise<boolean> {
  if (routeOf(realmId) === null) throw new TypeError('Invalid Realm discovery identity');
  const deadline = options.deadline ?? Date.now() + 30_000;
  const frontier = await discoverySnapshot(
    pool,
    DISCOVERY_PARTITION,
    deadline,
    async (client) =>
      (
        await client.query<DiscoveryState>(
          `SELECT ${stateColumns} FROM community.discovery_realm WHERE route=0 AND realm_id=$1`,
          [realmId],
        )
      ).rows[0],
  );
  const after = frontier?.applied_generation ?? '0';
  const result = await readRealmDiscoveryChanges(pool, { realmId, afterGeneration: after, limit: 50, deadline });
  // Own a closed immutable copy across the released source read and subsequent one-home commands.
  const page = structuredClone(result);
  const head = page.head;
  if (!head || page.changes.length > 50) unavailable();
  let expected = generation(after);
  for (const record of page.changes) {
    if (
      record.realmId !== realmId ||
      !record.realmEpoch ||
      routeOf(record.transactionId) === null ||
      generation(record.previousGeneration) !== expected ||
      generation(record.generation) !== expected + 1n
    )
      unavailable();
    expected++;
  }
  if (
    generation(head.generation) < expected ||
    (page.next !== null && (page.next !== expected.toString() || expected >= generation(head.generation))) ||
    (page.next === null && expected !== generation(head.generation))
  )
    unavailable();
  if (page.changes.length && page.next === null && page.changes.at(-1)!.realmEpoch !== head.realm_epoch) unavailable();
  if (!page.changes.length) {
    if (frontier && (frontier.realm_epoch !== head.realm_epoch || frontier.settled !== head.settled)) unavailable();
    return false;
  }
  // One source record per command bounds board bucket writes to 31, even for a 50-record catch-up page.
  for (const record of page.changes) {
    await runCommand(pool, { partition: DISCOVERY_PARTITION, deadline, clock: options.clock }, async (tx, command) => {
      await tx.query(
        `INSERT INTO community.discovery_realm(route,realm_id,realm_epoch,applied_generation,cutoff)
        VALUES(0,$1,$2,0,$3) ON CONFLICT DO NOTHING`,
        [realmId, record.realmEpoch, authoritativeTimeValue(command.time).slice(0, 10)],
      );
      const state = (
        await tx.query<DiscoveryState>(
          `SELECT ${stateColumns} FROM community.discovery_realm
        WHERE route=0 AND realm_id=$1 FOR UPDATE`,
          [realmId],
        )
      ).rows[0]!;
      if (generation(record.generation) <= generation(state.applied_generation)) return noEffect(null);
      if (state.applied_generation !== record.previousGeneration) unavailable();
      const cutoff = new Date(authoritativeTimeValue(command.time)).toISOString().slice(0, 10);
      if (record.value.kind === 'epoch') {
        await tx.query('DELETE FROM community.discovery_day WHERE route=0 AND realm_id=$1', [realmId]);
        await tx.query(
          `UPDATE community.discovery_realm SET realm_epoch=$2,settled=false WHERE route=0 AND realm_id=$1`,
          [realmId, record.realmEpoch],
        );
        await tx.query('UPDATE community.discovery_anchor SET publication_epoch=publication_epoch+1 WHERE route=0');
      } else {
        if (state.realm_epoch !== record.realmEpoch) unavailable();
        // Prune stale day totals before a retraction or board change, without scanning old buckets.
        await refreshDiscoveryTotals(tx, realmId, cutoff);
        if (record.value.kind === 'thread') await thread(tx, record, record.value.source, cutoff);
        else if (record.value.kind === 'board') await board(tx, record, cutoff);
        else if (record.value.kind === 'gate') {
          if (typeof record.value.settled !== 'boolean') unavailable();
          await tx.query('UPDATE community.discovery_realm SET settled=$2 WHERE route=0 AND realm_id=$1', [
            realmId,
            record.value.settled,
          ]);
        } else unavailable();
      }
      await refreshDiscoveryTotals(tx, realmId, cutoff);
      // The genuine snapshot head also covers initial generation-zero settlement
      // and epoch changes, which need not append a separate gate record. Only an
      // exact caught-up head may make this derived aggregate ready for disclosure.
      await tx.query(
        `UPDATE community.discovery_realm SET applied_generation=$2,
        settled=($2::bigint=$3::bigint AND realm_epoch=$4 AND $5::boolean)
        WHERE route=0 AND realm_id=$1`,
        [realmId, record.generation, head.generation, head.realm_epoch, head.settled],
      );
      return {
        value: null,
        events: [{ type: DISCOVERY_APPLIED, subject: realmId, data: { realmId, generation: record.generation } }],
      };
    });
  }
  return page.next !== null;
}
