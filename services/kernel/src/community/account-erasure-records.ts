import type { Pool } from 'pg';
import { readErasureStatus } from '../access/erasure.ts';
import { authoritativeTimeValue, mintReadTime, noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { TERMINAL_WORKFLOW_STATUSES } from '../work/retention.ts';
import { COMMUNITY_PLATFORM_BASIS } from './party-locator.ts';
import page from './account-erasure-records-page.sql';
import purgePage from './account-erasure-records-purge-page.sql';
import nextDue from './account-erasure-records-next-due.sql';
import removeLocator from './party-locator-delete.sql';
import eraseBan from './account-erasure-records-ban.sql';
import eraseTarget from './account-erasure-records-target.sql';
import eraseVerdict from './account-erasure-records-verdict.sql';
import eraseOperation from './account-erasure-records-operation.sql';
import readOperation from './account-erasure-records-operation-read.sql';
import readWorkflow from './account-erasure-records-workflow.sql';

const kinds = ['ban_actor', 'ban_target', 'membership_operation', 'verdict'] as const;
type Kind = (typeof kinds)[number];
export type CommunityRecordsCursor = { kind: Kind; dueAt: string; ownerRoute: number; ownerId: string; key: string };
type Dependencies = { pool: Pool; clock?: () => Date };
export const MEMBERSHIP_OPERATION_ENQUEUE_GRACE_MS = 60 * 60 * 1000;
type Locator = { kind: string; due_at: string; owner_route: number; owner_id: string; key: string };
const FIRST = {
  after_kind: '',
  after_due: '-infinity',
  after_route: -1,
  after_owner: '00000000-0000-0000-0000-000000000000',
  after_key: '',
};
const iso = (at: string) => new Date(at).toISOString();
function instant(at: string) {
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new TypeError('Invalid community erasure time');
  return at;
}
function cursor(after: CommunityRecordsCursor | null | undefined) {
  if (!after) return FIRST;
  if (
    !kinds.includes(after.kind) ||
    !Number.isFinite(Date.parse(after.dueAt)) ||
    routeOf(after.ownerId) !== after.ownerRoute ||
    routeOf(after.key) === null
  )
    throw new TypeError('Invalid community records cursor');
  return {
    after_kind: after.kind,
    after_due: after.dueAt,
    after_route: after.ownerRoute,
    after_owner: after.ownerId,
    after_key: after.key,
  };
}
function next(rows: Locator[]): CommunityRecordsCursor | null {
  const last = rows.at(-1);
  return rows.length === 50 && last
    ? {
        kind: last.kind as Kind,
        dueAt: last.due_at,
        ownerRoute: last.owner_route,
        ownerId: last.owner_id,
        key: last.key,
      }
    : null;
}
async function obligation(pool: Pool, accountId: string, erasedAt?: string) {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid community erasure account');
  const status = await readErasureStatus(pool, accountId);
  if (!status || !status.participants.community || (erasedAt !== undefined && iso(status.at) !== iso(erasedAt)))
    throw new Error('Community record erasure requires the committed account erasure obligation');
  return { route, account_id: accountId, erased_at: status.at };
}
async function readKeys<T>(pool: Pool, route: number, read: (client: Parameters<typeof page.run>[0]) => Promise<T>) {
  return withConnection(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (!partition || partition.writeState === 'moved') throw new Error('Community account partition is unavailable');
    return read(client);
  });
}
function changed(accountId: string) {
  return { type: 'com.rezics.community.account-records.erased.v1', subject: accountId, data: { accountId } };
}
async function remove(pool: Pool, accountId: string, route: number, row: Locator) {
  await runCommand(pool, { partition: partitionOf(route), basis: COMMUNITY_PLATFORM_BASIS }, async (tx) => {
    const parameters = { ...row, route, account_id: accountId };
    const result = await tx.query(
      removeLocator.sql,
      removeLocator.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    return result.rowCount ? { value: null, events: [changed(accountId)] } : noEffect(null);
  });
}
/** Read workflow disposition by its committed primary key, releasing the connection before the owner command.
 * Missing history is safe only after the enqueue grace; a known active workflow always stays pending.
 */
async function erasableOperation(pool: Pool, row: Locator, at: number): Promise<boolean> {
  return withConnection(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(row.owner_route));
    if (!partition || partition.writeState === 'moved') throw new Error('Community owner partition is unavailable');
    const operation = await readOperation.run(client, row);
    if (!operation) return true;
    // All membership producers commit the exact workflow ID as their command key.
    // It also survives minimization of another party on the same operation.
    const workflow = await readWorkflow.run(client, { id: operation.creation_idempotency_key });
    if (!workflow) return Date.parse(operation.requested_at) < at - MEMBERSHIP_OPERATION_ENQUEUE_GRACE_MS;
    return (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(workflow.status);
  });
}

/** At most 50 account-partition locator keys and one owner command per key.
 * No initiator is restored: only the already committed erasure obligation grants this platform work.
 * The caller folds reasonsKeptUntil across pages into the single realm_ban.reason retention exception
 * (complaint handling, expiring 183 days after each ban began).
 */
export async function eraseAccountCommunityRecordsPage(
  { pool, clock }: Dependencies,
  accountId: string,
  input: { erasedAt: string; after?: CommunityRecordsCursor | null },
) {
  instant(input.erasedAt);
  const key = await obligation(pool, accountId, input.erasedAt);
  const { rows, at } = await readKeys(pool, key.route, async (client) => {
    // Retry eligibility advances with the page's authoritative time; the erasure fence stays fixed at T.
    const time = await mintReadTime(client, clock);
    return {
      at: Date.parse(authoritativeTimeValue(time)),
      rows: await page.run(client, { ...key, ...cursor(input.after) }),
    };
  });
  let pending = 0;
  let reasonsKeptUntil: string | null = null;
  for (const row of rows) {
    if (row.kind === 'membership_operation' && !(await erasableOperation(pool, row, at))) {
      pending++;
      continue;
    }
    const result = await runCommand(
      pool,
      { partition: partitionOf(row.owner_route), basis: COMMUNITY_PLATFORM_BASIS },
      async (tx) => {
        const params = { ...row, ...key, purge: false };
        // Account route belongs only to locator commands; source statements use owner_route explicitly.
        let kept: string | null = null;
        let affected = 0;
        if (row.kind === 'ban_actor') {
          const result = await tx.query<{ kept_until: string | null }>(
            eraseBan.sql,
            eraseBan.params.map((name) => params[name as keyof typeof params]),
          );
          affected = result.rowCount ?? 0;
          kept = result.rows[0]?.kept_until ?? null;
        } else {
          const statement =
            row.kind === 'ban_target' ? eraseTarget : row.kind === 'verdict' ? eraseVerdict : eraseOperation;
          const result = await tx.query(
            statement.sql,
            statement.params.map((name) => params[name as keyof typeof params]),
          );
          affected = result.rowCount ?? 0;
        }
        return affected ? { value: kept, events: [changed(accountId)] } : noEffect(kept);
      },
    );
    // A ban against this account is deleted by its target key, including a self-issued ban.
    if (
      result.value &&
      row.key !== accountId &&
      (!reasonsKeptUntil || Date.parse(result.value) > Date.parse(reasonsKeptUntil))
    )
      reasonsKeptUntil = iso(result.value);
    if (row.kind !== 'ban_actor') await remove(pool, accountId, key.route, row);
  }
  return { next: next(rows), found: rows.length, pending, reasonsKeptUntil };
}

/** Purge each reason at its own expiry, preserving the ban and Access's independent denials. */
export async function purgeAccountBanReasonsPage(
  { pool }: Dependencies,
  accountId: string,
  input: { asOf: string; after?: CommunityRecordsCursor | null },
) {
  instant(input.asOf);
  const key = await obligation(pool, accountId);
  const rows = await readKeys(pool, key.route, (client) =>
    purgePage.run(client, { ...key, ...cursor(input.after), as_of: input.asOf }),
  );
  for (const row of rows) {
    await runCommand(pool, { partition: partitionOf(row.owner_route), basis: COMMUNITY_PLATFORM_BASIS }, async (tx) => {
      const parameters = { ...key, ...row, purge: true };
      const result = await tx.query(
        eraseBan.sql,
        eraseBan.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      return result.rowCount ? { value: null, events: [changed(accountId)] } : noEffect(null);
    });
    await remove(pool, accountId, key.route, row);
  }
  const remaining = await readKeys(pool, key.route, (client) => nextDue.run(client, key));
  return { next: next(rows), found: rows.length, nextDueAt: remaining ? iso(remaining.due_at) : null };
}
