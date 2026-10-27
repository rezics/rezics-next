import type { PoolClient } from 'pg';
import page from './active-account-page.sql';

/** Deployment enumeration only; release the client between pages and shareAccount inside each owner command. */
export async function pageActiveAccounts(
  client: PoolClient,
  input: { afterRoute: number; afterAccountId: string; limit: number },
): Promise<{ route: number; accountId: string }[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new RangeError('Active account page limit must be an integer from 1 to 100');
  return page.run(client, {
    after_route: input.afterRoute,
    after_account_id: input.afterAccountId,
    page_size: input.limit,
  });
}
