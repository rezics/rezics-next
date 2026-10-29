import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { migrate, schemaDump, testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount, type AuthService, type EffectAuthorization } from '../src/index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts } from '../src/workflows.ts';

let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let auth: AuthService;
let workflows: ReturnType<typeof createAccountWorkflows>;
let options: Parameters<typeof createAccountWorkflows>[0];
const openings = new Map<string, EffectAuthorization>();
const issuer = 'https://reduction.auth.test';
const password = randomBytes(24).toString('base64url');
let failOwner: string | undefined;
let pausedOwner: string | undefined;
let releaseIssuance: (() => void) | undefined;
let enteredIssuance: (() => void) | undefined;
const denied = async (): Promise<never> => {
  throw new Error('Unused port');
};
async function readAccount(id: string): Promise<AccessAccount | null> {
  return (await pool.query('SELECT value FROM reduction_account WHERE id=$1', [id])).rows[0]?.value ?? null;
}
async function request(path: string, body: unknown, cookie = '') {
  return auth.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}
async function signin(id: string, client = 'target', email = false) {
  return request('/signin', {
    ...(email ? { email: `${id}@example.test` } : { account_id: id }),
    password,
    client_id: client,
    scope: ['read'],
  });
}
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
async function owner(id: string) {
  await pool.query('INSERT INTO reduction_account VALUES ($1,$2)', [
    id,
    { accountId: id, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false },
  ]);
  await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
  await pool.query("UPDATE reduction_account SET value=jsonb_set(value,'{state}','\"active\"') WHERE id=$1", [id]);
}
async function restart() {
  await workflows.close();
  workflows = createAccountWorkflows(options);
  await workflows.start();
}
test('client reduction retains bounded native seek without forcing PostgreSQL planner settings', async () => {
  const source = await Bun.file(new URL('../src/account-workflows.ts', import.meta.url)).text();
  expect(source).not.toMatch(/\b(?:enable_seqscan|enable_bitmapscan|enable_sort)\b/i);
});
beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  await pool.query('CREATE TABLE reduction_account (id text PRIMARY KEY, value jsonb NOT NULL)');
  await pool.query('CREATE TABLE reduction_floor (key text PRIMARY KEY, value jsonb NOT NULL)');
  await pool.query('CREATE DATABASE reduction_system');
  const systemUrl = new URL(fixture.url);
  systemUrl.pathname = '/reduction_system';
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'reduction',
  };
  auth = await createAuthService({
    database: pool,
    issuer,
    audience: 'https://api.reduction.test',
    secret: 'reduction-only-secret-with-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
      },
      async readAccount(id) {
        if (id === pausedOwner) {
          pausedOwner = undefined;
          enteredIssuance?.();
          await new Promise<void>((resolve) => {
            releaseIssuance = resolve;
          });
        }
        return readAccount(id);
      },
      readRecoveryAccount: readAccount,
      async consumeAuthorization({ authorization }) {
        const receipt = openings.get(authorization);
        if (!receipt) throw new Error('No opening authorization');
        openings.delete(authorization);
        return receipt;
      },
      authorizeProvisioning: async (accountId) => ({ accountId }),
    }),
  });
  const ports: AccountWorkflowPorts = {
    registrationTarget: (key) => key,
    reserveHandle: denied,
    createPending: denied,
    claimHandle: denied,
    activate: denied,
    expireRegistration: denied,
    releaseExpiredRegistrationHandle: denied,
    provisioningReference: denied,
    provisioningEvidence: denied,
    authorizeOperation: async () => ({ actor: { accountId: 'approved-admin' } }),
    authorizeOpening: async () => ({ value: { receiptId: 'native-opening' } }),
    async readAccount(id) {
      const account = await readAccount(id);
      return (
        account && {
          accountId: account.accountId,
          handle: null,
          operatorAccountId: null,
          state: account.state,
          fenced: account.fenced ?? false,
        }
      );
    },
    async raiseFence(input) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const prior = (await connection.query('SELECT value FROM reduction_floor WHERE key=$1', [input.key])).rows[0];
        if (prior) {
          await connection.query('COMMIT');
          return { value: prior.value };
        }
        const current = (
          await connection.query('SELECT value FROM reduction_account WHERE id=$1 FOR UPDATE', [input.accountId])
        ).rows[0]!.value;
        const value = {
          accountId: input.accountId,
          receiptId: `floor:${input.key}`,
          minimumAuthnEpoch: String(current.authnEpoch + 1),
          kind: 'fence',
          priorOperatorAccountId: null,
        };
        await connection.query('UPDATE reduction_account SET value=$2 WHERE id=$1', [
          input.accountId,
          { ...current, fenced: true, authnEpoch: Number(value.minimumAuthnEpoch) },
        ]);
        await connection.query('INSERT INTO reduction_floor VALUES ($1,$2)', [input.key, value]);
        await connection.query('COMMIT');
        return { value };
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
  options = {
    database: pool,
    systemDatabaseUrl: systemUrl.href,
    stagingKey: randomBytes(32),
    access: ports,
    auth: {
      ...auth,
      internal: {
        ...auth.internal,
        async revokeSessions(id, cleanup) {
          expect((await readAccount(id))?.fenced).toBe(true);
          if (id === failOwner) throw new Error('Injected Auth outage');
          await auth.internal.revokeSessions(id, cleanup);
        },
      },
    },
  };
  workflows = createAccountWorkflows(options);
  await workflows.start();
}, 60000);
afterAll(async () => {
  await workflows?.close();
  await pool?.end();
  fixture?.close();
}, 60000);

test('bounded production behavior preserves security outcomes through missing sessions, deletion, race and DBOS resume', async () => {
  for (const clientId of ['target', 'other'])
    await auth.internal.registerClient({ clientId, firstParty: true, scopes: ['read', 'write'] });
  await owner('a-owner');
  await owner('b-owner');
  await owner('c-deleted');
  await owner('z-late');
  const first = await signin('a-owner', 'target', true);
  expect(first.status).toBe(200);
  const token = await request('/token', {}, cookieOf(first));
  expect(token.status).toBe(200);
  const jwt = decodeJwt((await token.json()).access_token);
  await auth.internal.revokeSessions('a-owner');
  expect((await pool.query('SELECT id FROM session WHERE "userId"=$1', ['a-owner'])).rows).toHaveLength(0);
  expect((await signin('b-owner')).status).toBe(200);
  expect((await signin('c-deleted')).status).toBe(200);
  await pool.query(
    'UPDATE reduction_account SET value=value || \'{"state":"deleted","fenced":true,"authnEpoch":2}\'::jsonb WHERE id=\'c-deleted\'',
  );
  await auth.internal.eraseAccount('c-deleted');
  // One hundred unrelated owners per ordinary affected owner, with authority for another client only.
  await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt")
    SELECT 'unrelated-'||i,'','unrelated-'||i||'@example.test',false,now(),now() FROM generate_series(1,400) i`);
  await pool.query(
    `INSERT INTO auth_consent SELECT 'unrelated-'||i,'other',ARRAY['read'] FROM generate_series(1,400) i`,
  );
  const entered = new Promise<void>((resolve) => {
    enteredIssuance = resolve;
  });
  // The first Access read is before the session hook; stop inside the hook by using email signin.
  pausedOwner = 'z-late';
  const late = signin('z-late', 'target', true);
  await entered;
  failOwner = 'b-owner';
  const reduction = workflows.reduceClientScopes({
    key: 'reduce',
    authorization: 'approved',
    clientId: 'target',
    firstParty: false,
    scopes: ['read'],
  });
  releaseIssuance!();
  expect((await late).status).toBe(200);
  await expect(reduction).rejects.toThrow();
  expect(
    (
      await pool.query('SELECT account_id FROM auth_consent WHERE client_id=$1 ORDER BY account_id', ['target'])
    ).rows.map((r) => r.account_id),
  ).toEqual(['a-owner', 'b-owner', 'c-deleted', 'z-late']);
  expect((await signin('z-late')).status).toBeGreaterThanOrEqual(400);
  const operationId = (
    await pool.query('SELECT operation_id FROM auth_client_reduction WHERE client_id=$1', ['target'])
  ).rows[0].operation_id;
  await expect(
    auth.internal.finishClientReduction({ clientId: 'target', operationId, firstParty: false, scopes: ['read'] }),
  ).rejects.toThrow();
  await expect(
    auth.internal.clientReductionPage({ clientId: 'target', operationId, after: 'zz-skip', limit: 2 }),
  ).rejects.toThrow();
  await expect(
    auth.internal.beginClientReduction({ clientId: 'target', operationId, firstParty: false, scopes: [] }),
  ).rejects.toThrow();
  expect((await readAccount('a-owner'))!.authnEpoch).toBeGreaterThan(jwt.authn_epoch as number);
  failOwner = undefined;
  await restart();
  await workflows.resumeClientReduction('reduce');
  const floors = (await pool.query('SELECT value FROM reduction_floor')).rows.map((r) => r.value.accountId).sort();
  // A deleted owner is terminal: the reduction advances past it without a floor.
  expect(floors).toEqual(['a-owner', 'b-owner', 'z-late']);
  expect((await pool.query('SELECT id FROM session WHERE "clientId"=$1', ['target'])).rows).toHaveLength(0);
  expect((await pool.query('SELECT first_party,scopes FROM auth_client WHERE client_id=$1', ['target'])).rows).toEqual([
    { first_party: false, scopes: ['read'] },
  ]);
  await auth.internal.finishClientReduction({ clientId: 'target', operationId, firstParty: false, scopes: ['read'] });
  await expect(
    auth.internal.finishClientReduction({
      clientId: 'target',
      operationId: 'wrong-operation',
      firstParty: false,
      scopes: ['read'],
    }),
  ).rejects.toThrow();
  await expect(
    auth.internal.beginClientReduction({ clientId: 'other', operationId, firstParty: false, scopes: ['read'] }),
  ).rejects.toThrow();
  await owner('other-owner');
  const other = await signin('other-owner', 'other');
  expect(other.status).toBe(200);
  expect((await request('/token', {}, cookieOf(other))).status).toBe(200);
}, 60000);

test('native website, password, key and delegated issuance materialize implicit consent before session insertion', async () => {
  await auth.internal.registerClient({ clientId: 'native-default', firstParty: true, scopes: ['read', 'write'] });
  await pool.query(`CREATE FUNCTION require_native_consent() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."clientId"='native-default' AND NOT EXISTS
        (SELECT 1 FROM auth_consent WHERE client_id=NEW."clientId" AND account_id=NEW."userId")
      THEN RAISE EXCEPTION 'Session preceded consent authority'; END IF;
      RETURN NEW;
    END $$`);
  await pool.query(
    'CREATE TRIGGER native_consent BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION require_native_consent()',
  );
  try {
    for (const id of ['native-human', 'native-password', 'native-key', 'native-bot']) await owner(id);
    const human = await signin('native-human', 'native-default', true);
    expect(human.status).toBe(200);
    expect((await signin('native-password', 'native-default')).status).toBe(200);
    const key = await generateKeyPair('ES256', { extractable: true });
    await pool.query('INSERT INTO auth_public_key VALUES ($1,$2,$3)', [
      'native-key',
      'own',
      { ...(await exportJWK(key.publicKey)), alg: 'ES256' },
    ]);
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({
      iss: 'native-key',
      sub: 'native-key',
      aud: `${issuer}/token`,
      iat: now,
      exp: now + 60,
      jti: 'native-key-once',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'own' })
      .sign(key.privateKey);
    const ownKey = await request('/signin/key', {
      account_id: 'native-key',
      assertion,
      client_id: 'native-default',
      scope: ['read'],
    });
    expect(ownKey.status).toBe(200);
    await pool.query(`UPDATE reduction_account SET value=jsonb_set(value,'{automated}','true') WHERE id='native-bot'`);
    openings.set('native-opening', {
      receiptId: 'native-opening',
      subjectAccountId: 'native-bot',
      actingHumanId: 'native-human',
      operatorAccountId: 'native-human',
      purpose: 'session',
      clientId: 'native-default',
      scopes: ['read'],
      humanEpoch: 1,
      subjectEpoch: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const delegated = await workflows.openOperatorSession({
      key: 'native-delegated',
      authorization: 'approved',
      operatorAccountId: 'native-human',
      subjectAccountId: 'native-bot',
      headers: new Headers({ cookie: cookieOf(human) }),
    });
    expect(delegated.status).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT account_id,scopes FROM auth_consent WHERE client_id='native-default' ORDER BY account_id",
        )
      ).rows,
    ).toEqual(
      ['native-bot', 'native-human', 'native-key', 'native-password'].map((account_id) => ({
        account_id,
        scopes: ['read', 'write'],
      })),
    );
    for (const response of [human, ownKey, delegated])
      expect((await request('/token', {}, cookieOf(response))).status).toBe(200);
    await pool.query(`INSERT INTO session (id,token,"userId","clientId","grantedScope","authnEpoch","authTime","authMethods","createdAt","updatedAt","expiresAt")
      SELECT 'retained-'||i,'retained-token-'||i,'native-password','native-default','read',1,1,'pwd',now(),now(),now()+interval '1 day'
      FROM generate_series(1,201) i`);
    // Native admission caps all stored sessions; the bounded cleanup can remove this entire cohort.
    expect(
      (await pool.query(`SELECT count(*)::integer AS n FROM session WHERE "userId"='native-password'`)).rows[0].n,
    ).toBe(64);
    await auth.internal.revokeSessions('native-key');
    await workflows.reduceClientScopes({
      key: 'reduce-native',
      authorization: 'approved',
      clientId: 'native-default',
      firstParty: false,
      scopes: ['read'],
    });
    expect(
      (await pool.query(`SELECT count(*)::integer AS n FROM session WHERE "userId"='native-password'`)).rows[0].n,
    ).toBe(0);
    const floor = (await pool.query("SELECT value FROM reduction_floor WHERE value->>'accountId'='native-password'"))
      .rows[0].value;
    await auth.internal.revokeSessions('native-password', {
      boundedCleanup: true,
      barrier: { ...floor, minimumAuthnEpoch: Number(floor.minimumAuthnEpoch) },
    });
    expect(
      (await pool.query(`SELECT count(*)::integer AS n FROM session WHERE "userId"='native-password'`)).rows[0].n,
    ).toBe(0);
    expect((await request('/token', {}, cookieOf(human))).status).toBeGreaterThanOrEqual(400);
    for (const id of ['native-bot', 'native-human', 'native-key', 'native-password'])
      expect((await readAccount(id))?.fenced).toBe(true);
  } finally {
    await pool.query('DROP TRIGGER native_consent ON session');
    await pool.query('DROP FUNCTION require_native_consent()');
  }
}, 60000);

test('legacy deployment coverage is an explicit bounded barrier and migrations produce the committed dump', async () => {
  await auth.internal.registerClient({ clientId: 'legacy', firstParty: true, scopes: ['read'] });
  await pool.query(
    "UPDATE auth_client_coverage SET ready=false,after_ordinal=0,ready_after=now()+interval '5 minutes' WHERE client_id='legacy'",
  );
  await expect(
    auth.internal.beginClientReduction({
      clientId: 'legacy',
      operationId: 'legacy-reduction',
      firstParty: false,
      scopes: [],
    }),
  ).rejects.toThrow();
  expect((await signin('other-owner', 'legacy')).status).toBeGreaterThanOrEqual(400);
  await expect(auth.internal.backfillClientIssuance({ clientId: 'legacy', limit: 101 })).rejects.toThrow();
  let pages = 0;
  let result;
  do {
    result = await auth.internal.backfillClientIssuance({ clientId: 'legacy', limit: 17 });
    pages++;
  } while (result.next !== null);
  expect(pages).toBeGreaterThan(20);
  expect(result.ready).toBe(false);
  await pool.query("UPDATE auth_client_coverage SET ready_after=now()-interval '1 second' WHERE client_id='legacy'");
  expect((await auth.internal.backfillClientIssuance({ clientId: 'legacy', limit: 17 })).ready).toBe(true);
  expect((await signin('other-owner', 'legacy')).status).toBe(200);
  migrate(fixture.url);
  // Test-only tables are removed before comparing the generated schema.
  await pool.query('DROP TABLE reduction_account, reduction_floor');
  expect(schemaDump(fixture.url, fixture)).toBe(await Bun.file(new URL('../db/schema.sql', import.meta.url)).text());
}, 60000);
