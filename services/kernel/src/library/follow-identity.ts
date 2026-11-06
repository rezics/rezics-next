import type { PoolClient } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import { lockCountOwner } from './follow-count-source.ts';

type FollowIdentityClient = Pick<PoolClient, 'query'>;

export type FollowIdentityCursor = Readonly<{ partition: number; accountId: string }> | null;
export type FollowIdentityHandoff = Readonly<{
  accountId: string;
  ownerPartition: number;
  reason: 'foreign-owner' | 'foreign-target';
}>;
export type FollowIdentityPage = Readonly<{
  after: FollowIdentityCursor;
  exhausted: boolean;
  examined: number;
  handoffs: readonly FollowIdentityHandoff[];
}>;
type Disposition = 'OLD' | 'NEW' | 'first-apply';

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Follow identity requires a native subject or account id');
  return value;
}

async function lockTotals(tx: FollowIdentityClient, targetIds: readonly string[]) {
  const ids = [...new Set(targetIds)].sort();
  const routes = ids.map(route);
  const rows = await tx.query<{ route: number; target_id: string }>(
    `SELECT route,target_id::text FROM library.follow_count_total
     WHERE (route,target_id) IN (SELECT * FROM unnest($1::integer[],$2::uuid[]))
     ORDER BY route,target_id FOR UPDATE`,
    [routes, ids],
  );
  if (rows.rowCount !== ids.length) throw new Error('Follow identity target total is not initialized');
}

async function changeSupport(tx: FollowIdentityClient, targetId: string, accountId: string, delta: -1 | 1) {
  const targetRoute = route(targetId);
  const args = [targetRoute, 'subject', targetId, accountId];
  if (delta > 0)
    await tx.query(
      `INSERT INTO library.follow_count_support(route,target_type,target_id,account_id,support)
       VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING`,
      args,
    );
  const selected = await tx.query<{ support: string }>(
    `SELECT support::text FROM library.follow_count_support
     WHERE route=$1 AND target_type=$2 AND target_id=$3 AND account_id=$4 FOR UPDATE`,
    args,
  );
  const before = BigInt(selected.rows[0]?.support ?? '0');
  const after = before + BigInt(delta);
  if (after < 0n) throw new Error('Follow identity support cannot become negative');
  if (after === 0n)
    await tx.query(
      `DELETE FROM library.follow_count_support
       WHERE route=$1 AND target_type=$2 AND target_id=$3 AND account_id=$4`,
      args,
    );
  else
    await tx.query(
      `UPDATE library.follow_count_support SET support=$5
       WHERE route=$1 AND target_type=$2 AND target_id=$3 AND account_id=$4`,
      [...args, after.toString()],
    );
  if ((before === 0n) !== (after === 0n)) {
    const total = await tx.query(
      `UPDATE library.follow_count_total SET total=total+$4
       WHERE route=$1 AND target_type=$2 AND target_id=$3 AND total+$4>=0`,
      [targetRoute, 'subject', targetId, after === 0n ? -1 : 1],
    );
    if (total.rowCount !== 1) throw new Error('Follow identity total cannot represent the support transition');
  }
}

async function removeOldPair(tx: FollowIdentityClient, original: string, targetId: string, accountId: string) {
  const removed = await tx.query<{ eligible: boolean }>(
    `DELETE FROM library.follow_count_pair
     WHERE route=$1 AND target_type='subject' AND target_id=$2 AND account_id=$3 AND original_id=$4
     RETURNING eligible`,
    [route(targetId), targetId, accountId, original],
  );
  if (removed.rows[0]?.eligible) await changeSupport(tx, targetId, accountId, -1);
}

async function writeNewPair(
  tx: FollowIdentityClient,
  input: { original: string; targetId: string; accountId: string; revision: bigint; eligible: boolean },
): Promise<boolean> {
  const targetRoute = route(input.targetId);
  const args = [targetRoute, 'subject', input.targetId, input.accountId, input.original];
  const prior = (
    await tx.query<{ revision: string; eligible: boolean }>(
      `SELECT revision::text,eligible FROM library.follow_count_pair
       WHERE route=$1 AND target_type=$2 AND target_id=$3 AND account_id=$4 AND original_id=$5 FOR UPDATE`,
      args,
    )
  ).rows[0];
  if (prior) {
    const comparison = input.revision - BigInt(prior.revision);
    if (comparison < 0n) return false;
    if (comparison === 0n) {
      if (prior.eligible !== input.eligible) throw new Error('Conflicting equal follow identity revision');
      return true;
    }
  }
  const before = prior?.eligible ?? false;
  if (input.eligible !== before) await changeSupport(tx, input.targetId, input.accountId, input.eligible ? 1 : -1);
  await tx.query(
    `INSERT INTO library.follow_count_pair(route,target_type,target_id,account_id,original_id,revision,eligible)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(route,target_type,target_id,account_id,original_id)
     DO UPDATE SET revision=EXCLUDED.revision,eligible=EXCLUDED.eligible`,
    [...args, input.revision.toString(), input.eligible],
  );
  return true;
}

/** Re-key one bounded indexed page. Global discovery returns locators only; a foreign owner/target is
 * retained as a precise handoff. Source rows remain on their account home and negative rows are included.
 */
export async function applyFollowIdentityPage(
  tx: FollowIdentityClient,
  input: Readonly<{
    partition: number;
    original: string;
    previousTerminal: string;
    terminal: string;
    disposition: Disposition;
    after: FollowIdentityCursor;
    limit?: number;
  }>,
): Promise<FollowIdentityPage> {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Follow identity page must be 1..100');
  const oldRoute = route(input.previousTerminal);
  const newRoute = route(input.terminal);
  if (partitionOf(route(input.original)) !== input.partition)
    throw new Error('Follow identity original must stay on the admitted participant home');
  if (input.previousTerminal === input.terminal && input.disposition !== 'first-apply')
    return { after: input.after, exhausted: true, examined: 0, handoffs: [] };

  const rows = await tx.query<{ owner_partition: number; account_id: string }>(
    `SELECT owner_partition,account_id::text FROM (
       SELECT s.partition_no AS owner_partition,s.account_id FROM library.follow_count_source s
       WHERE s.target_type='subject' AND s.target_id=$1
       UNION
       SELECT ((get_byte(uuid_send(p.account_id),10)*256+get_byte(uuid_send(p.account_id),11)) >> 4),p.account_id
       FROM library.follow_count_pair p
       WHERE p.route=$2 AND p.target_type='subject' AND p.target_id=$3 AND p.original_id=$1
     ) followers
     WHERE ($4::integer IS NULL OR (owner_partition,account_id)>($4,$5::uuid))
     ORDER BY owner_partition,account_id LIMIT $6`,
    [
      input.original,
      oldRoute,
      input.previousTerminal,
      input.after?.partition ?? null,
      input.after?.accountId ?? null,
      limit + 1,
    ],
  );
  const selected = rows.rows.slice(0, limit);
  const handoffs: FollowIdentityHandoff[] = [];
  const targetHomes = new Set([partitionOf(oldRoute), partitionOf(newRoute)]);

  for (const candidate of selected) {
    const accountId = candidate.account_id;
    const accountRoute = route(accountId);
    const accountPartition = partitionOf(accountRoute);
    if (accountPartition !== input.partition) {
      handoffs.push({ accountId, ownerPartition: accountPartition, reason: 'foreign-owner' });
      continue;
    }
    if ([...targetHomes].some((home) => home !== input.partition)) {
      handoffs.push({
        accountId,
        ownerPartition: [...targetHomes].find((home) => home !== input.partition)!,
        reason: 'foreign-target',
      });
      continue;
    }

    const owner = await lockCountOwner(tx, accountId);
    const source = (
      await tx.query<{
        revision: string;
        source_following: boolean;
        desired_eligible: boolean;
      }>(
        `SELECT revision::text,source_following,desired_eligible FROM library.follow_count_source
         WHERE route=$1 AND account_id=$2 AND target_type='subject' AND target_id=$3 FOR UPDATE`,
        [owner.route, accountId, input.original],
      )
    ).rows[0];
    const raw = (
      await tx.query<{ state: string; target_type: string }>(
        `SELECT state,target_type FROM library.follow
         WHERE route=$1 AND account_id=$2 AND target_id=$3 FOR SHARE`,
        [owner.route, accountId, input.original],
      )
    ).rows[0];
    const following = raw?.target_type === 'subject' && raw.state === 'following';
    let revision = source ? BigInt(source.revision) : 1n;
    if (source) {
      const eligibleNow = owner.active && following;
      if (source.source_following !== following || source.desired_eligible !== eligibleNow) {
        const updated = await tx.query<{ revision: string }>(
          `UPDATE library.follow_count_source SET revision=revision+1,source_following=$4,
             desired_eligible=$5,pending_since=LEAST(pending_since,statement_timestamp())
           WHERE route=$1 AND account_id=$2 AND target_type='subject' AND target_id=$3
           RETURNING revision::text`,
          [owner.route, accountId, input.original, following, eligibleNow],
        );
        revision = BigInt(updated.rows[0]!.revision);
      }
    }

    if (input.disposition === 'OLD') {
      await lockTotals(tx, [input.previousTerminal]);
      await removeOldPair(tx, input.original, input.previousTerminal, accountId);
      continue;
    }

    await lockTotals(tx, [input.terminal]);
    const oldFence = await tx.query(
      `SELECT 1 FROM library.follow_count_terminal_follower WHERE partition_no=$1 AND account_id=$2`,
      [input.partition, accountId],
    );
    if (oldFence.rowCount || owner.terminal)
      await tx.query(
        `INSERT INTO library.follow_count_terminal_follower(partition_no,account_id)
         VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [input.partition, accountId],
      );
    const destinationFence = await tx.query(
      `SELECT 1 FROM library.follow_count_terminal_follower WHERE partition_no=$1 AND account_id=$2`,
      [input.partition, accountId],
    );
    if (!source) continue;
    const accepted = await writeNewPair(tx, {
      original: input.original,
      targetId: input.terminal,
      accountId,
      revision,
      eligible: owner.active && following && !destinationFence.rowCount,
    });
    if (!accepted) continue;
    await tx.query(
      `DELETE FROM library.follow_count_destination
       WHERE route=$1 AND account_id=$2 AND target_type='subject' AND original_id=$3`,
      [accountRoute, accountId, input.original],
    );
    await tx.query(
      `INSERT INTO library.follow_count_destination(route,account_id,target_type,original_id,destination_route,destination_id)
       VALUES($1,$2,'subject',$3,$4,$5)`,
      [accountRoute, accountId, input.original, newRoute, input.terminal],
    );
  }

  const last = selected.at(-1);
  return {
    after: last ? { partition: last.owner_partition, accountId: last.account_id } : input.after,
    exhausted: rows.rows.length <= limit,
    examined: selected.length,
    handoffs,
  };
}
