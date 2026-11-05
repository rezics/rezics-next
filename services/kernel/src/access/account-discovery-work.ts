import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { deadlineFor } from '../request/deadline.ts';
import { maintainPublicFilterCoverageHome } from '../semantic/public-filter-coverage-maintenance.ts';
import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';

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

/** Default production service, plus source-event wakeups for normal mutations.
 * The sweep catches installation, direct native writers and missed wakeups. Each
 * step is bounded and does not hold any connection across foreign commands.
 */
export function registerAccountDiscoveryWork(context: WorkContext): void {
  context.addEffects([
    {
      name: 'account_discovery_redrive',
      types: ['com.rezics.access.account-updated.v1', 'com.rezics.access.account-tombstoned.v1'],
      async run(event) {
        const data = event.data as { accountId?: string };
        const route = data.accountId ? routeOf(data.accountId) : null;
        if (route !== null)
          await redriveAccountDiscovery({ pool: context.pool, clock: context.clock }, partitionOf(route));
      },
    },
  ]);
  context.addService(() => {
    let stopped = false;
    let partition = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> = Promise.resolve();
    const tick = () => {
      pending = (async () => {
        try {
          const result = await redriveAccountDiscovery({ pool: context.pool, clock: context.clock }, partition);
          if (!result.more) partition = (partition + 1) % 4096;
        } catch (error) {
          console.error('Account discovery redrive failed', error);
        }
        if (!stopped) timer = setTimeout(tick, 10);
      })();
    };
    timer = setTimeout(tick, 0);
    return {
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await pending;
      },
    };
  });
}
