import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { newId, routeOf } from '../../kernel/src/route/route.ts';
import { createAuthService, type AuthService, type InvalidationReceipt } from '../src/index.ts';

await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
let bindings: ReturnType<typeof import('../../kernel/src/access/auth-bindings.ts').createAuthBindings>;
let lifecycle: ReturnType<typeof import('../../kernel/src/access/lifecycle.ts').createLifecycleInternals>;

const issuer = 'https://fenced-cleanup.auth.test';
let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let service: AuthService;
let sequence = 0;

// Real Access account rows; Auth keeps only the user, its consent to the client and its sessions.
async function seed(operator: string | null = null, client = 'target') {
  const id = newId(0x9300);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,operator_account_id,transaction_id)
    VALUES ($1,$2,'actor','active',$3,$4)`,
    [routeOf(id)!, id, operator, newId(routeOf(id)!)],
  );
  await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,'',$2,false)`, [
    id,
    `${id}@example.test`,
  ]);
  await pool.query('INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)', [
    id,
    client,
    ['read', 'write'],
  ]);
  for (let i = 0; i < 3; i++)
    await pool.query(
      `INSERT INTO session (id,"expiresAt",token,"updatedAt","userId","clientId","grantedScope","authnEpoch","authTime","authMethods")
      VALUES ($1,now()+interval '1 hour',$1,now(),$2,$3,'read',1,0,'pwd')`,
      [`session-${++sequence}`, id, client],
    );
  return id;
}
async function fence(accountId: string): Promise<InvalidationReceipt> {
  const { value } = await lifecycle.raiseFence({ accountId, key: `fence:${accountId}` });
  return { receiptId: value.receiptId, accountId, minimumAuthnEpoch: Number(value.minimumAuthnEpoch) };
}
const sessions = async (id: string) => (await pool.query('SELECT id FROM session WHERE "userId"=$1', [id])).rowCount;
const cleanup = (id: string, barrier: InvalidationReceipt) =>
  service.internal.revokeSessions(id, { boundedCleanup: true, barrier });

beforeAll(async () => {
  fixture = testDatabase();
  migrateKernel(fixture.url);
  pool = new Pool({ connectionString: fixture.url });
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = fixture.url;
  try {
    const { createAuthBindings } = await import('../../kernel/src/access/auth-bindings.ts');
    const { createLifecycleInternals } = await import('../../kernel/src/access/lifecycle.ts');
    bindings = createAuthBindings({ pool });
    lifecycle = createLifecycleInternals({
      pool,
      routeKey: new Uint8Array(32),
      provisioningEvidence: async () => null,
      recoveryEvidence: async () => null,
    });
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
  const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'k' };
  service = await createAuthService({
    database: pool,
    issuer,
    audience: 'https://fenced-cleanup.api.test',
    secret: 'fenced-cleanup-only-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts(bindings),
  });
  await service.internal.registerClient({ clientId: 'target', firstParty: false, scopes: ['read', 'write'] });
  for (let ready = false; !ready;) {
    ready = (await service.internal.backfillClientIssuance({ clientId: 'target', limit: 10 })).ready;
    if (!ready) await Bun.sleep(20);
  }
}, 60_000);
afterAll(async () => {
  await pool.end();
  fixture?.close();
});

test('after a client reduction fences an automated account its sessions are cleaned up and the reduction completes', async () => {
  const human = await seed();
  const robot = await seed(human);
  const operationId = 'reduction-with-automation';
  const reduction = { clientId: 'target', operationId, firstParty: false, scopes: ['read'] };
  await service.internal.beginClientReduction(reduction);
  const page = await service.internal.clientReductionPage({ clientId: 'target', operationId, after: '', limit: 10 });
  expect([...page.items].sort()).toEqual([human, robot].sort());
  expect(page.next).toBeNull();
  for (const id of page.items) {
    const barrier = await fence(id);
    await cleanup(id, barrier);
    expect(await sessions(id)).toBe(0);
    await service.internal.completeClientReductionOwner({ clientId: 'target', operationId, accountId: id, barrier });
    // A repeated cleanup replays the retained receipt.
    await cleanup(id, barrier);
  }
  await service.internal.finishClientReduction(reduction);
  expect((await pool.query('SELECT scopes FROM auth_client WHERE client_id=$1', ['target'])).rows[0].scopes).toEqual([
    'read',
  ]);
  expect((await pool.query('SELECT 1 FROM auth_client_reduction_progress WHERE completed')).rowCount).toBe(1);
  expect((await pool.query('SELECT 1 FROM auth_effect_receipt WHERE purpose=$1', ['client-reduction'])).rowCount).toBe(
    2,
  );
});

test('an ordinary fenced account is cleaned up as before', async () => {
  const human = await seed();
  const barrier = await fence(human);
  expect(await bindings.readAccount(human)).toBeNull();
  expect(await bindings.readRecoveryAccount!(human)).toMatchObject({
    accountId: human,
    fenced: true,
    automated: false,
  });
  await cleanup(human, barrier);
  expect(await sessions(human)).toBe(0);
});

test('cleanup still refuses an account that is not fenced or whose floor is below the barrier', async () => {
  const human = await seed();
  const robot = await seed(human);
  for (const id of [human, robot]) {
    // Not fenced: no session is touched, whatever barrier is presented.
    await expect(cleanup(id, { receiptId: 'unfenced', accountId: id, minimumAuthnEpoch: 1 })).rejects.toThrow();
    expect(await sessions(id)).toBe(3);
    const barrier = await fence(id);
    await expect(cleanup(id, { ...barrier, minimumAuthnEpoch: barrier.minimumAuthnEpoch + 1 })).rejects.toThrow();
    await expect(cleanup(id, { ...barrier, accountId: human === id ? robot : human })).rejects.toThrow();
    expect(await sessions(id)).toBe(3);
  }
});

test('recovery still refuses automated accounts while the cleanup read returns them with their fence and floor', async () => {
  const human = await seed();
  const robot = await seed(human);
  const unfenced = await seed(human);
  const barrier = await fence(robot);
  expect(await bindings.readRecoveryAccount!(robot)).toBeNull();
  expect(await bindings.readAccount(robot)).toBeNull();
  expect(await bindings.readFencedAccount(robot)).toEqual({
    accountId: robot,
    kind: 'actor',
    state: 'active',
    authnEpoch: barrier.minimumAuthnEpoch,
    automated: true,
    fenced: true,
  });
  // The cleanup read never returns an account that is not fenced.
  expect(await bindings.readFencedAccount(unfenced)).toBeNull();
  expect(await bindings.readFencedAccount(human)).toBeNull();
});
