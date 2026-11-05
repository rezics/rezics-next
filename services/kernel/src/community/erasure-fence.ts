import type { PoolClient } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import lock from './erasure-fence-lock.sql';

function key(accountId: string) {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid community erasure fence account');
  return { route, account_id: accountId };
}

/** Locks the account-local fence without changing an existing row version. */
export async function lockErasureFence(
  client: CommandTransaction | PoolClient,
  accountId: string,
): Promise<string | null> {
  return (await lock.run(client, key(accountId)))?.closed_at ?? null;
}

/** Closes the account-local locator fence before the community participant pages. */
export async function closeErasureFence(client: CommandTransaction | PoolClient, accountId: string): Promise<string> {
  const input = key(accountId);
  await lock.run(client, input);
  const {
    rows: [row],
  } = await client.query<{ closed_at: string }>(
    `UPDATE community.erasure_fence
     SET closed_at = COALESCE(closed_at, transaction_timestamp())
     WHERE route=$1 AND account_id=$2
     RETURNING closed_at::text`,
    [input.route, accountId],
  );
  if (!row) throw new Error('Community erasure fence row disappeared while closing');
  return row.closed_at;
}
