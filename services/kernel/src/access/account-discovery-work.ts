import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { deadlineFor } from '../request/deadline.ts';
import { maintainPublicFilterCoverageHome } from '../semantic/public-filter-coverage-maintenance.ts';
import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { classifyUnavailability } from './unavailable.ts';

const basis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-access',
  requestedBy: null,
};
type Intent = { route: number; accountId: string; revision: string };
function validate(input: Intent) {
  const route = routeOf(input.accountId);
  if (
    route === null ||
    !Number.isInteger(input.route) ||
    input.route < 0 ||
    input.route > 65535 ||
    !/^[1-9][0-9]{0,18}$/.test(input.revision) ||
    BigInt(input.revision) > 9223372036854775807n
  )
    throw new TypeError('Account discovery intent requires exact native keys and revision');
  return route;
}

/** Actual Account-anchor command, independent of the foreign claim transaction.
 * The persisted source intent is probed before obtaining Account command custody.
 * Per-claim-partition high water survives receipt/history expiry and makes replay
 * harmless. Every cursor write and source revision advance commits together.
 */
export async function consumeAccountDiscoveryClaim(deps: { pool: Pool; clock?: () => Date }, input: Intent) {
  const route = validate(input);
  const claimPartition = partitionOf(input.route);
  const source = await withConnection(deps.pool, (client) =>
    client.query(
      `SELECT 1 FROM access.account_discovery_claim_intent
     WHERE route=$1 AND account_id=$2 AND revision >= $3::bigint`,
      [input.route, input.accountId, input.revision],
    ),
  );
  if (!source.rowCount) return false;
  const command = await runCommand(
    deps.pool,
    { partition: partitionOf(route), clock: deps.clock, basis },
    async (tx) => {
      const account = await tx.query<{ state: string }>(
        'SELECT state FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE',
        [route, input.accountId],
      );
      if (!account.rows[0] || account.rows[0].state === 'deleted') return noEffect(true);
      const consumed = await tx.query(
        `INSERT INTO access.account_discovery_claim_cursor(route,account_id,claim_partition,revision)
       VALUES ($1,$2,$3,$4::bigint) ON CONFLICT (route,account_id,claim_partition)
       DO UPDATE SET revision=EXCLUDED.revision
       WHERE access.account_discovery_claim_cursor.revision < EXCLUDED.revision RETURNING revision`,
        [route, input.accountId, claimPartition, input.revision],
      );
      if (!consumed.rowCount) return noEffect(true);
      // The native hook assigns the revision and queues the source notification.
      await tx.query(
        'UPDATE access.account SET discovery_revision=discovery_revision WHERE route=$1 AND account_id=$2',
        [route, input.accountId],
      );
      return {
        value: true,
        events: [
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: input.accountId,
            data: { accountId: input.accountId },
          },
        ],
      };
    },
  );
  return command.value;
}

/** Delete an exact producer obligation only by atomically replacing it with an
 * ordinary durable source event. This is delivery, never a Search repair ACK.
 */
export async function deliverAccountDiscoveryIntent(
  deps: { pool: Pool; clock?: () => Date },
  input: Intent,
  source: 'account' | 'claim',
) {
  validate(input);
  return runCommand(deps.pool, { partition: partitionOf(input.route), clock: deps.clock, basis }, async (tx) => {
    const table = source === 'account' ? 'account_discovery_intent' : 'account_discovery_claim_intent';
    const removed = await tx.query(
      `DELETE FROM access.${table} WHERE route=$1 AND account_id=$2 AND revision=$3::bigint RETURNING revision`,
      [input.route, input.accountId, input.revision],
    );
    if (!removed.rowCount) return noEffect(false);
    return {
      value: true,
      events: [
        {
          type: 'com.rezics.access.account-discovery-changed.v1',
          subject: input.accountId,
          data: { ...input, source },
        },
      ],
    };
  });
}

/** One indexed finite native page, with released custody between anchors. A
 * caller may repeat the partition; coalescing and consumed high water are durable.
 */
export async function redriveAccountDiscovery(
  deps: { pool: Pool; clock?: () => Date },
  partition: number,
  limit = 100,
) {
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition > 4095 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new RangeError('Account discovery redrive requires a native partition and limit 1..100');
  const read = (table: 'account_discovery_intent' | 'account_discovery_claim_intent') =>
    withConnection(
      deps.pool,
      async (client) =>
        (
          await client.query<Intent>(
            `SELECT route, account_id::text AS "accountId", revision::text FROM access.${table}
       WHERE route >= $1 AND route < $2 ORDER BY route,account_id LIMIT $3`,
            [partition * 16, (partition + 1) * 16, limit],
          )
        ).rows,
    );
  const foreign = await read('account_discovery_claim_intent');
  let delivered = 0;
  for (const input of foreign) {
    if (await consumeAccountDiscoveryClaim(deps, input))
      delivered += (await deliverAccountDiscoveryIntent(deps, input, 'claim')).value ? 1 : 0;
  }
  const local = await read('account_discovery_intent');
  for (const input of local) delivered += (await deliverAccountDiscoveryIntent(deps, input, 'account')).value ? 1 : 0;
  // Delivery remains independent of native registration apply. Only the Source
  // maintainer adopts committed receiver receipts and retires its own barriers.
  const coverage = await maintainPublicFilterCoverageHome(deps.pool, partition, {
    deadline: deadlineFor(DEFAULT_REQUEST_DEADLINE_MS),
  });
  return { delivered, more: foreign.length === limit || local.length === limit || coverage.more };
}

/** A missed wakeup is recovered within this interval plus one bounded pass. */
export const ACCOUNT_DISCOVERY_IDLE_MS = 15 * 60_000;
export const ACCOUNT_DISCOVERY_START_DELAY_MS = 1_000;
export const ACCOUNT_DISCOVERY_STEP_MS = 10;
export const ACCOUNT_DISCOVERY_RETRY_MS = 1_000;
export const ACCOUNT_DISCOVERY_MAX_RETRY_MS = 60_000;
const PARTITIONS = 4096;

/** Timer port keeps scheduling tests independent of wall time and global timers. */
export type AccountDiscoveryTimers = {
  now(): number;
  schedule(run: () => Promise<void>, delay: number): () => void;
};
const timers: AccountDiscoveryTimers = {
  now: Date.now,
  schedule(run, delay) {
    const timer = setTimeout(() => void run(), delay);
    return () => clearTimeout(timer);
  },
};

/** Recovery shares one serial worker with source-event wakeups, so it holds at
 * most one pool connection, leaving the rest for boot and foreground requests.
 * It starts after SDK launch with a one-second grace and yields if the pool has
 * waiters or only one free slot. Empty steady state: zero queries during the
 * 15-minute idle interval; an empty 4096-home pass costs 32,768 SQL statements
 * (two intent reads plus six coverage statements per home), about 35 SQL/s
 * averaged over pass + idle at the minimum 10 ms step, versus about 800 SQL/s
 * continuously before backoff. Events wake only their home without restarting
 * that idle scan. Durable intents make coalesced in-memory wakeups disposable.
 */
export function registerAccountDiscoveryWork(context: WorkContext, time: AccountDiscoveryTimers = timers): void {
  const wakeups = new Set<number>();
  let wake = () => {};
  context.addEffects([
    {
      name: 'account_discovery_redrive',
      types: ['com.rezics.access.account-updated.v1', 'com.rezics.access.account-tombstoned.v1'],
      async run(event) {
        const data = event.data as { accountId?: string };
        const route = data.accountId ? routeOf(data.accountId) : null;
        if (route !== null) {
          wakeups.add(partitionOf(route));
          wake();
        }
      },
    },
  ]);
  context.addService(() => {
    let stopped = false;
    let running = false;
    let partition = 0;
    let passWorked = false;
    let preferSweep = false;
    let sweepAt = time.now() + ACCOUNT_DISCOVERY_START_DELAY_MS;
    let availableAt = sweepAt;
    let retry = ACCOUNT_DISCOVERY_RETRY_MS;
    let failed: { home: number; sweep: boolean } | undefined;
    let cancel: (() => void) | undefined;
    let pending: Promise<void> = Promise.resolve();

    const schedule = () => {
      if (stopped || running) return;
      cancel?.();
      const next = wakeups.size ? time.now() : sweepAt;
      cancel = time.schedule(tick, Math.max(0, Math.max(availableAt, next) - time.now()));
    };
    const step = async () => {
      // Do not join a boot/foreground checkout queue or consume its last slot.
      const pool = context.pool;
      if (pool.waitingCount || pool.totalCount - pool.idleCount >= (pool.options.max ?? 10) - 1) {
        availableAt = time.now() + ACCOUNT_DISCOVERY_RETRY_MS;
        return;
      }
      const sweep = failed?.sweep ?? (time.now() >= sweepAt && (preferSweep || !wakeups.size));
      const home = failed?.home ?? (sweep ? partition : wakeups.values().next().value!);
      // Delete before awaiting: an event during delivery must survive this step.
      if (!sweep) wakeups.delete(home);
      try {
        const result = await redriveAccountDiscovery({ pool, clock: context.clock }, home);
        failed = undefined;
        retry = ACCOUNT_DISCOVERY_RETRY_MS;
        availableAt = time.now() + ACCOUNT_DISCOVERY_STEP_MS;
        preferSweep = !sweep;
        if (!sweep) {
          if (result.more) wakeups.add(home);
          return;
        }
        passWorked ||= result.delivered > 0 || result.more;
        if (!result.more) {
          partition = (partition + 1) % PARTITIONS;
          if (partition === 0) {
            sweepAt = time.now() + (passWorked ? ACCOUNT_DISCOVERY_STEP_MS : ACCOUNT_DISCOVERY_IDLE_MS);
            passWorked = false;
          }
        }
      } catch (error) {
        if (!sweep) wakeups.add(home);
        if (classifyUnavailability(error) === undefined) throw error;
        failed = { home, sweep };
        console.error('Account discovery redrive failed', error);
        // Wakeups never bypass pressure backoff; retry the same failed home.
        availableAt = time.now() + retry;
        retry = Math.min(retry * 2, ACCOUNT_DISCOVERY_MAX_RETRY_MS);
      }
    };
    const tick = async () => {
      if (stopped) return;
      cancel = undefined;
      running = true;
      pending = step();
      try {
        await pending;
      } finally {
        running = false;
      }
      schedule();
    };
    wake = schedule;
    schedule();
    return {
      async stop() {
        stopped = true;
        wake = () => {};
        cancel?.();
        await pending;
      },
    };
  });
}
