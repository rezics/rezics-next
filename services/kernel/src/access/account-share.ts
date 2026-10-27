import { hasLiveCommandTransaction, type CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import share from './account-share.sql';

/** Hold the account against deletion until the owning command commits or rolls back.
 * Call before creating per-account state; this does not replace command authorization.
 */
export async function shareAccount(tx: CommandTransaction, accountId: string): Promise<'active'> {
  const route = routeOf(accountId);
  if (route === null || !hasLiveCommandTransaction(tx)) throw new LifecycleDeniedError();
  const account = await share.run(tx, { route, account_id: accountId });
  if (!account || account.state !== 'active' || account.fenced) throw new LifecycleDeniedError();
  return 'active';
}
