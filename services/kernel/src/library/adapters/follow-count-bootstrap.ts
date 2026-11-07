import {
  bootstrapFollowCountOwner,
  countTransaction,
  lockCountOwner,
  ZERO_COUNT_KEY,
  type CountRuntime,
} from './follow-count-source.ts';

/** Each physical owner is discovered in finite immutable account-key coverage.
 * Account creation after hook installation initializes its source counter natively. */
export async function discoverFollowCountOwners(deps: CountRuntime, partition: number) {
  return countTransaction(deps, partition * 16, 'library.follow-count.owner-discovery', async (tx) => {
    const start = partition * 16,
      end = start + 16;
    const state = (
      await tx.query<{
        source_complete: boolean;
        discovery_started: boolean;
        owner_route: number | null;
        owner_id: string | null;
        upper_route: number | null;
        upper_owner: string | null;
      }>('SELECT * FROM library.follow_count_partition WHERE partition_no=$1 FOR UPDATE', [partition])
    ).rows[0];
    if (!state) throw new Error('Missing follow count source topology');
    if (state.source_complete) return { examined: 0, complete: true };
    let upperRoute = state.upper_route,
      upperOwner = state.upper_owner;
    if (!state.discovery_started) {
      const upper = (
        await tx.query<{ route: number; account_id: string }>(
          'SELECT route,account_id FROM access.account WHERE route >= $1 AND route < $2 ORDER BY route DESC,account_id DESC LIMIT 1',
          [start, end],
        )
      ).rows[0];
      upperRoute = upper?.route ?? null;
      upperOwner = upper?.account_id ?? null;
      await tx.query(
        'UPDATE library.follow_count_partition SET discovery_started=true,upper_route=$2,upper_owner=$3 WHERE partition_no=$1',
        [partition, upperRoute, upperOwner],
      );
    }
    const keys =
      upperOwner === null
        ? []
        : (
            await tx.query<{ route: number; account_id: string }>(
              `SELECT route,account_id FROM access.account WHERE route >= $1 AND route < $2
       AND (route,account_id)>($3,$4) AND (route,account_id)<=($5,$6)
       ORDER BY route,account_id LIMIT 100`,
              [start, end, state.owner_route ?? start, state.owner_id ?? ZERO_COUNT_KEY, upperRoute, upperOwner],
            )
          ).rows;
    // The native barrier prevents discovery from recreating terminal payload.
    for (const key of keys) await lockCountOwner(tx, key.account_id);
    await tx.query(
      'UPDATE library.follow_count_partition SET owner_route=$2,owner_id=$3,source_complete=$4 WHERE partition_no=$1',
      [
        partition,
        keys.at(-1)?.route ?? state.owner_route,
        keys.at(-1)?.account_id ?? state.owner_id,
        keys.length < 100,
      ],
    );
    return { examined: keys.length, complete: keys.length < 100 };
  });
}

const TARGETS = [
  { table: 'semantic.subject', id: 'subject_id', type: 'subject' },
  { table: 'library.collection', id: 'collection_id', type: 'collection' },
  { table: 'community.space', id: 'space_id', type: 'space' },
] as const;
export async function bootstrapFollowCountTargets(deps: CountRuntime, partition: number) {
  return countTransaction(deps, partition * 16, 'library.follow-count.target-bootstrap', async (tx) => {
    const state = (
      await tx.query<{
        target_kind: number;
        target_after: string | null;
        target_route: number | null;
        target_started: boolean;
        target_upper: string | null;
        target_upper_route: number | null;
      }>('SELECT * FROM library.follow_count_partition WHERE partition_no=$1 FOR UPDATE', [partition])
    ).rows[0];
    if (!state) throw new Error('Missing follow count source topology');
    const target = TARGETS[state.target_kind];
    if (!target) return { examined: 0, complete: true };
    const start = partition * 16,
      end = start + 16;
    let upper = state.target_upper,
      upperRoute = state.target_upper_route;
    if (!state.target_started) {
      // Only fixed trusted table/column declarations enter SQL text.
      const key = (
        await tx.query<{ route: number; id: string }>(
          `SELECT route,${target.id} AS id FROM ${target.table}
        WHERE route >= $1 AND route < $2 ORDER BY route DESC,${target.id} DESC LIMIT 1`,
          [start, end],
        )
      ).rows[0];
      upper = key?.id ?? null;
      upperRoute = key?.route ?? null;
      await tx.query(
        'UPDATE library.follow_count_partition SET target_started=true,target_upper=$2,target_upper_route=$3 WHERE partition_no=$1',
        [partition, upper, upperRoute],
      );
    }
    const keys =
      upper === null
        ? []
        : (
            await tx.query<{ route: number; id: string }>(
              `SELECT route,${target.id} AS id FROM ${target.table}
      WHERE route >= $1 AND route < $2 AND (route,${target.id})>($3,$4) AND (route,${target.id})<=($5,$6)
      ORDER BY route,${target.id} LIMIT 100`,
              [start, end, state.target_route ?? start, state.target_after ?? ZERO_COUNT_KEY, upperRoute, upper],
            )
          ).rows;
    for (const key of keys)
      await tx.query(
        `INSERT INTO library.follow_count_total(route,target_type,target_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [key.route, target.type, key.id],
      );
    if (keys.length < 100)
      await tx.query(
        `UPDATE library.follow_count_partition SET target_kind=target_kind+1,
      target_started=false,target_after=NULL,target_route=NULL,target_upper=NULL,target_upper_route=NULL WHERE partition_no=$1`,
        [partition],
      );
    else
      await tx.query(
        'UPDATE library.follow_count_partition SET target_route=$2,target_after=$3 WHERE partition_no=$1',
        [partition, keys.at(-1)!.route, keys.at(-1)!.id],
      );
    return { examined: keys.length, complete: keys.length < 100 && state.target_kind === 2 };
  });
}

export async function bootstrapNextFollowCountOwner(deps: CountRuntime, partition: number) {
  const owner = await countTransaction(
    deps,
    partition * 16,
    'library.follow-count.bootstrap-key',
    async (tx) =>
      (
        await tx.query<{ account_id: string }>(
          `SELECT account_id FROM library.follow_count_owner WHERE partition_no=$1 AND NOT bootstrap_complete ORDER BY route,account_id LIMIT 1`,
          [partition],
        )
      ).rows[0],
  );
  return owner ? bootstrapFollowCountOwner(deps, owner.account_id) : { examined: 0, complete: true };
}
