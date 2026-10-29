import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createMembershipWorkPorts, registerAccounts } from '../../src/access/membership-work.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { LIFECYCLE_ACTIONS, type LifecycleRequest } from '../../src/access/lifecycle.ts';
import { routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork, type WorkModule } from '../../src/work/registry.ts';
import type { Access } from '../../src/request/access.ts';

export async function authenticated(
  pool: ReturnType<typeof createPool>,
  id: string,
  access?: Access,
  scopes: readonly string[] = [...LIFECYCLE_ACTIONS.keys()],
): Promise<LifecycleRequest> {
  const deadline = Date.now() + 30_000;
  const claims = {
    kind: 'account' as const,
    accountId: id,
    clientId: 'fixture',
    scopes,
    requestedBy: null,
    authnEpoch: 1,
  };
  return {
    actor: access ? await authenticateAccount(access, { pool, deadline }, claims) : claims,
    account: await withConnection(pool, (connection) => readAccount(connection, routeOf(id)!, id)),
    deadline,
  };
}

if (import.meta.main) {
  const pool = createPool(process.env.DATABASE_URL!);
  pool.options.max = 1;
  const client = await createWorkClient(process.env.DATABASE_URL!);
  let control = {
    id: 0,
    actor: process.env.MEMBERSHIP_ACTOR ?? '',
    stop: process.env.MEMBERSHIP_STOP ?? '',
    fail: process.env.MEMBERSHIP_FAIL === 'yes',
  };
  if (process.env.MEMBERSHIP_CONTROL === 'yes') {
    let pending = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        control = JSON.parse(line) as typeof control;
        console.log(`configured:${control.id}`);
        newline = pending.indexOf('\n');
      }
    });
  }
  const actions = new Map(LIFECYCLE_ACTIONS);
  const access = admittedAccess({ actions });
  const module: WorkModule = {
    name: 'accounts',
    register(context) {
      assert.equal(DBOS.isInitialized(), false);
      const ports = createMembershipWorkPorts(context, {
        access,
        async authorize(reference) {
          if (reference !== 'authenticated-fixture') throw new Error('No approval');
          const request = await authenticated(pool, control.actor);
          return {
            ...request,
            actor: await authenticateAccount(access, { pool, deadline: Date.now() + 10_000 }, request.actor),
          };
        },
      });
      const wrapped = { ...ports };
      for (const phase of ['reserve', 'publish', 'terminalize', 'release'] as const) {
        const original = ports[phase];
        // Stop after the native commit, before DBOS journals the step result.
        const wrap = async (...args: Parameters<typeof original>) => {
          if (control.stop === `before-${phase}`) {
            console.log(`boundary:before-${phase}:${control.id}`);
            process.kill(process.pid, 'SIGSTOP');
          }
          if (phase === 'publish' && control.fail) throw new Error('Publication unavailable');
          const result = await (original as Function)(...args);
          const accountId =
            phase === 'reserve'
              ? result.value.accountId
              : ((args as unknown[])[phase === 'publish' ? 2 : 0] as { accountId: string }).accountId;
          const missing = await pool.query(
            "SELECT m.organization_id FROM access.organization_member m WHERE m.member_account_id=$1 AND upper_inf(m.valid) AND NOT EXISTS (SELECT 1 FROM access.membership_inverse i WHERE i.route=$2 AND i.account_id=$1 AND i.kind='organization' AND i.group_id=m.organization_id)",
            [accountId, routeOf(accountId)],
          );
          assert.deepEqual(missing.rows, []);

          if (control.stop === phase) {
            console.log(`boundary:${phase}:${control.id}`);
            process.kill(process.pid, 'SIGSTOP');
          }
          return result;
        };
        Object.assign(wrapped, { [phase]: wrap });
      }
      registerAccounts(context, wrapped);
    },
  };
  const options = {
    pool,
    client,
    databaseUrl: process.env.DATABASE_URL!,
    env: { KERNEL_ROUTE_KEY: Buffer.alloc(32, 59).toString('base64url') },
  };
  if (process.env.MEMBERSHIP_REGISTRY === 'yes') {
    await assert.rejects(composeWork([module, module], options), /Duplicate work module: accounts/);
    let registrations = 0;
    const original = client.registerQueue.bind(client);
    client.registerQueue = async (...args) => {
      registrations++;
      return original(...args);
    };
    const runtime = await composeWork([module], options);
    assert.equal(registrations, 6);
    assert.equal(DBOS.isInitialized(), false);
    const launch = runtime.launch();
    assert.equal(runtime.launch(), launch);
    await launch;
    await assert.rejects(composeWork([module], options), /already/);
    await runtime.shutdown();
    await client.close();
    await pool.end();
    console.log('registry-ok');
  } else {
    const runtime = await composeWork([module], options);
    await runtime.launch();
    console.log('worker-ready');
    process.on('SIGTERM', () => {
      void runtime
        .shutdown()
        .then(() => client.close())
        .then(() => pool.end())
        .then(() => process.exit(0));
    });
  }
}
