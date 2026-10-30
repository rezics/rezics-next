import type { AccessClient } from '../request/access.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { authoritativeTimeValue, CommandUnavailableError } from '../command/command.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import read from './member-count-read.sql';
import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { PARTITIONS } from '../route/route.ts';
import { COMMUNITY_PLATFORM_BASIS } from './party-locator.ts';

export type RealmMemberCount = Readonly<{ count: number; version: string }>;

/** Native same-home source data only. The caller owns current Realm disclosure. */
export function readRealmMemberCount(
  client: AccessClient,
  input: Readonly<{ realmId: string; at: AuthoritativeTime }>,
): Promise<RealmMemberCount | null> {
  const route = routeOf(input.realmId);
  if (route === null) throw new TypeError('Invalid Realm member count key');
  const at = authoritativeTimeValue(input.at);
  const partitionNo = partitionOf(route);
  return readPartition(client, partitionNo)
    .then((partition) => {
      if (!partition) throw new CommandUnavailableError('contention', partitionNo);
      if (partition.writeState === 'moved') throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
      if (partition.writeState !== 'active') throw new CommandUnavailableError('fenced', partitionNo);
      return read.run(client, { route, realm_id: input.realmId, at });
    })
    .then((row) => {
      if (!row) return null;
      if (
        typeof row.version !== 'string' ||
        row.version.length > 19 ||
        !/^(0|[1-9][0-9]*)$/.test(row.version) ||
        BigInt(row.version) > 9223372036854775807n
      )
        throw new TypeError('Invalid Realm member count version');
      const count = Number(row.count);
      if (
        typeof row.count !== 'string' ||
        row.count.length > 16 ||
        !/^(0|[1-9][0-9]*)$/.test(row.count) ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        throw new TypeError('Invalid Realm member count');
      return { count, version: row.version };
    });
}

/** One native segment: fifty raw Realm install keys OR fifty raw open source
 * keys. Progress and deltas share the source control lock and command snapshot. */
export async function maintainRealmMemberCounts(pool: Pool, partition: number): Promise<boolean> {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Invalid member count partition');
  const result = await runCommand(pool, { partition, basis: COMMUNITY_PLATFORM_BASIS }, async (tx) => {
    const install = await tx.query<{
      cursor_route: number;
      cursor_id: string;
      frontier_route: number;
      frontier_id: string;
    }>(
      `SELECT cursor_route,cursor_id,frontier_route,frontier_id
        FROM community.realm_member_count_install WHERE partition_no=$1 AND NOT complete FOR UPDATE`,
      [partition],
    );
    const progress = install.rows[0];
    if (progress) {
      const page = await tx.query<{ route: number; realm_id: string }>(
        `SELECT route,realm_id FROM community.realm
         WHERE route BETWEEN $1 AND $2 AND (route,realm_id)>($3,$4::uuid)
           AND (route,realm_id)<=($5,$6::uuid) ORDER BY route,realm_id LIMIT 50`,
        [
          partition * 16,
          partition * 16 + 15,
          progress.cursor_route,
          progress.cursor_id,
          progress.frontier_route,
          progress.frontier_id,
        ],
      );
      for (const row of page.rows)
        await tx.query('SELECT community.ensure_realm_member_count($1,$2::uuid)', [row.route, row.realm_id]);
      const last = page.rows.at(-1);
      await tx.query(
        `UPDATE community.realm_member_count_install SET cursor_route=$2,cursor_id=$3,complete=$4
         WHERE partition_no=$1`,
        [
          partition,
          last?.route ?? progress.frontier_route,
          last?.realm_id ?? progress.frontier_id,
          page.rows.length < 50,
        ],
      );
      return noEffect(true);
    }
    const pending = await tx.query<{ route: number; realm_id: string }>(
      `SELECT route,realm_id FROM community.realm_member_count
       WHERE route BETWEEN $1 AND $2 AND NOT initialized ORDER BY route,realm_id LIMIT 1 FOR UPDATE`,
      [partition * 16, partition * 16 + 15],
    );
    const next = pending.rows[0];
    if (!next) return noEffect(false);
    await tx.query('SELECT community.seed_realm_member_count($1,$2::uuid)', [next.route, next.realm_id]);
    return noEffect(true);
  });
  return result.value;
}
