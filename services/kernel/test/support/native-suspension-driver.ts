import type { Pool } from 'pg';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createReinstatementCommands } from '../../src/access/reinstatement.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from './admitted-access.ts';

/** Component fixtures provision staff authority, then use the production suspension command.
 * The subject's bearer must be obtained before calling this: suspension raises its floor and fence.
 */
async function staffCommand(
  pool: Pool,
  accountId: string,
  action: 'account:suspend' | 'account:reinstate',
): Promise<void> {
  const staff = newId(0xfffe);
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(staff), staff],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$3)`,
    [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, staff, action],
  );
  const access = admittedAccess({ actions: new Map([[action, { anonymous: false }]]) });
  const context = { pool, deadline: Date.now() + 30_000 };
  const actor = await authenticateAccount(access, context, {
    accountId: staff,
    clientId: 'suspension-fixture',
    scopes: [action],
  });
  const config = { pool, access, clock: () => new Date() };
  const input = { accountId, key: crypto.randomUUID(), reason: 'Native suspension fixture' };
  if (action === 'account:suspend') await createSuspensionCommands(config).suspend({ ...context, actor }, input);
  else await createReinstatementCommands(config).reinstate({ ...context, actor }, input);
}

export const suspendAccount = (pool: Pool, accountId: string) => staffCommand(pool, accountId, 'account:suspend');
export const reinstateAccount = (pool: Pool, accountId: string) => staffCommand(pool, accountId, 'account:reinstate');

/** State matrices may reuse their fixture identity; suspension itself always crosses the staff command. */
export async function setFixtureAccountState(pool: Pool, accountId: string, state: string): Promise<void> {
  const current = await pool.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [
    routeOf(accountId),
    accountId,
  ]);
  if (current.rows[0]?.state === 'suspended') await reinstateAccount(pool, accountId);
  if (state === 'suspended') {
    await pool.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(accountId),
      accountId,
    ]);
    await suspendAccount(pool, accountId);
  } else {
    await pool.query('UPDATE access.account SET state=$3 WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
      state,
    ]);
  }
}
