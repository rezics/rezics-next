import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { principalCommandIdentity } from '../../../src/command/command.ts';
import type { OperationalOptions } from '../../../src/command/operational.ts';
import { accessCommandAuthorization, type AccountActor } from '../../../src/request/access.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { WORK_QUEUES } from '../../../src/work/queues.ts';
import { openGrowthDatabase } from '../../support/growth.ts';
import { testAccess } from '../../support/test-kernel.ts';

export class Denied extends Error {}
export const workflowName = 'test.operational';
export const action = 'subject:create';

export async function operationalFixture(partition: number) {
  const db = await openGrowthDatabase();
  const workClient = await createWorkClient(db.url, db.pool);
  for (const [name, parameters] of Object.entries(WORK_QUEUES)) await workClient.registerQueue(name, parameters);
  const issuer = 'https://operational-auth.example.test';
  const audience = 'https://api.example.test';
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'operational', alg: 'ES256' };
  const access = testAccess({
    pool: db.pool,
    actions: new Map([[action, { anonymous: false }]]),
    auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
  });
  const accounts = [newId(0xc100), newId(0xc110)].sort();
  for (const id of accounts)
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
       VALUES($1,$2,'actor','active',$3)`,
      [routeOf(id), id, Bun.randomUUIDv7()],
    );
  async function authenticate(scope = action): Promise<AccountActor> {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ client_id: 'web', scope, authn_epoch: 1, auth_time: now, amr: ['pwd'] })
      .setProtectedHeader({ alg: 'ES256', kid: 'operational', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(accounts[0]!)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    return access.authenticate(token, { pool: db.pool, deadline: Date.now() + 180_000 });
  }
  const actor = await authenticate();
  const restricted = await authenticate('account:read');
  const resource = { route: partition << 4, id: newId(partition << 4) };
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$3,$4,'(,)',$5)`,
    [resource.route, resource.id, actor.accountId, action, Bun.randomUUIDv7()],
  );
  async function request(identity = actor, deadline = Date.now() + 5000): Promise<OperationalOptions> {
    return {
      ...principalCommandIdentity(identity),
      mode: 'request',
      partition,
      kind: 'test.derived-preparation',
      accounts,
      workClient,
      deadline,
      authorization: await accessCommandAuthorization(
        access,
        identity,
        action,
        resource,
        { pool: db.pool, deadline },
        () => new Denied('permission denied'),
      ),
    };
  }
  const step: OperationalOptions = {
    mode: 'work-step',
    partition,
    kind: 'test.derived-apply',
    accounts,
    workClient,
  };
  return {
    db,
    workClient,
    accounts,
    actor,
    restricted,
    resource,
    request,
    step,
    async close() {
      await workClient.close();
      await db.close();
    },
  };
}
