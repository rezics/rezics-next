import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { accessClock } from '../access/access-clock.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { PLATFORM_RESOURCE } from '../access/bootstrap-governance.ts';
import globalContext from '../access/bootstrap-governance-read.sql';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import source from './realm-claim-review-source.sql';
import page from './realm-claim-review-page.sql';
import current from './realm-claim-review-current.sql';
import type { Access, Actor } from '../request/access.ts';

export type RealmClaimReviewItem = Readonly<{
  realmId: string;
  requestId: string;
  claimantAccountId: string;
  state: 'pending';
  orphanedAt: string;
  claimEligibleAt: string;
  requestedAt: string;
}>;
export type RealmClaimReviewPage = Readonly<{
  claimRequests: readonly RealmClaimReviewItem[];
  next: string | null;
}>;

// The selected dependency interface has no token configuration. Cursors use the
// native signer with a process-lifetime key; restart requires a fresh first page.
const tokens: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const denied = () => new ProblemError('not_found');

/** One current episode, one bounded seek, then fresh authority and source checks.
 * Accounts' approval command remains the only writer and grant producer.
 */
export async function listRealmClaimRequests(
  deps: { pool: Pool; access: Access; clock?: () => Date },
  actor: Actor,
  input: { realmId: string; cursor?: string; limit?: number },
  context: { deadline: number },
): Promise<RealmClaimReviewPage> {
  const { realmId } = input;
  const route = routeOf(realmId);
  if (actor.kind !== 'account' || route === null) throw denied();
  if (!Number.isFinite(context.deadline) || Date.now() >= context.deadline) throw new ProblemError('deadline_exceeded');
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  const examined = Math.min(limit, 20);
  const clock = deps.clock ?? accessClock(deps.access);
  const accessContext = { pool: deps.pool, deadline: context.deadline };
  const binding = {
    operation: 'community.realm.claim-review',
    parameters: {
      realmId,
      limit,
      viewer: actor.accountId,
      client: actor.clientId,
      requestedBy: actor.requestedBy,
    },
  };
  // Mint on a released connection before ordinary Access prepares actor evidence.
  async function admission() {
    const time = await withConnection(deps.pool, (client) =>
      mintReadTime(deadlineClient(client, context.deadline), clock),
    );
    try {
      const check = await accessCheck(deps.access, actor, 'realm:approve_claim', PLATFORM_RESOURCE, {
        ...accessContext,
        time,
      });
      return { time, check };
    } catch (error) {
      releaseOperationalTime(time);
      throw error;
    }
  }
  async function snapshot<T>(work: (client: ReturnType<typeof deadlineClient>) => Promise<T>): Promise<T> {
    return withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    });
  }
  async function partition(client: ReturnType<typeof deadlineClient>, targetRoute: number) {
    const value = await readPartition(client, partitionOf(targetRoute));
    if (!value || value.writeState === 'moved') throw new ProblemError('partition_unavailable');
    return value;
  }
  async function authorize(client: ReturnType<typeof deadlineClient>, prepared: Awaited<ReturnType<typeof admission>>) {
    await partition(client, PLATFORM_RESOURCE.route);
    if (
      !(await globalContext.run(client, { route: PLATFORM_RESOURCE.route, resource_id: PLATFORM_RESOURCE.id }))
        ?.global ||
      !(await prepared.check(client, prepared.time))
    )
      throw denied();
  }

  const initialAccess = await admission();
  let initial;
  try {
    // Reject unauthorized callers before checking out any Realm source.
    await snapshot((client) => authorize(client, initialAccess));
    initial = await snapshot(async (client) => {
      const home = await partition(client, route);
      const at = authoritativeTimeValue(initialAccess.time);
      const realm = await source.run(client, { route, realm: realmId, at });
      if (!realm?.orphaned_at || !realm.claim_eligible_at) throw denied();
      let after = '00000000-0000-0000-0000-000000000000';
      if (input.cursor !== undefined) {
        const decoded = decodeCursor(tokens, binding, input.cursor);
        if (
          !decoded.ok ||
          decoded.after.length !== 4 ||
          typeof decoded.after[0] !== 'string' ||
          routeOf(decoded.after[0]) !== route
        )
          throw new ProblemError('invalid_cursor');
        if (
          decoded.epoch !== home.epoch ||
          decoded.after[1] !== realm.orphaned_at ||
          decoded.after[2] !== realm.lifecycle_version ||
          decoded.after[3] !== realm.discovery_epoch
        )
          throw new ProblemError('stale_cursor');
        after = decoded.after[0];
      }
      const rows = await page.run(client, {
        route,
        realm: realmId,
        orphaned: realm.orphaned_at,
        after,
        limit: examined,
        at,
      });
      return { realm, rows, epoch: home.epoch };
    });
  } finally {
    releaseOperationalTime(initialAccess.time);
  }

  // Reprepare outside source checkout, so revocation, restore and re-orphaning
  // committed during preparation are visible in the final snapshot.
  const finalAccess = await admission();
  try {
    return await snapshot(async (client) => {
      const home = await partition(client, route);
      const at = authoritativeTimeValue(finalAccess.time);
      const realm = await source.run(client, { route, realm: realmId, at });
      const before = initial.realm;
      if (
        !realm?.orphaned_at ||
        !realm.claim_eligible_at ||
        home.epoch !== initial.epoch ||
        realm.orphaned_at !== before.orphaned_at ||
        realm.claim_eligible_at !== before.claim_eligible_at ||
        realm.head_revision_id !== before.head_revision_id ||
        realm.lifecycle_version !== before.lifecycle_version ||
        realm.discovery_epoch !== before.discovery_epoch
      )
        throw denied();
      const rows =
        initial.rows.length === 0
          ? []
          : await current.run(client, {
              route,
              realm: realmId,
              orphaned: realm.orphaned_at,
              requests: initial.rows.map((row) => row.request_id),
              at,
            });
      const verified = new Map(rows.map((row) => [row.request_id, row]));
      const claimRequests: RealmClaimReviewItem[] = [];
      for (const row of initial.rows) {
        const live = verified.get(row.request_id);
        if (
          !row.current_request ||
          !live?.current_request ||
          live.account_id !== row.account_id ||
          live.requested_at !== row.requested_at
        )
          continue;
        claimRequests.push({
          realmId,
          requestId: row.request_id,
          claimantAccountId: row.account_id,
          state: 'pending',
          orphanedAt: new Date(realm.orphaned_at).toISOString(),
          claimEligibleAt: new Date(realm.claim_eligible_at).toISOString(),
          requestedAt: new Date(row.requested_at).toISOString(),
        });
      }
      // Ordinary Access evaluates the exact action directly on Global, in this
      // fresh snapshot, using the actual actor. No target-local role can replace it.
      await authorize(client, finalAccess);
      const last = initial.rows.at(-1);
      const next =
        initial.rows.length === examined && last
          ? encodeCursor(tokens, binding, {
              epoch: home.epoch,
              after: [last.request_id, realm.orphaned_at, realm.lifecycle_version, realm.discovery_epoch],
            })
          : null;
      return { claimRequests, next };
    });
  } finally {
    releaseOperationalTime(finalAccess.time);
  }
}
