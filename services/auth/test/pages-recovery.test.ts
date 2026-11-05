import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount, type AuthService, type AuthServiceOptions } from '../src/index.ts';

const issuer = 'https://pages-recovery.auth.test';
const password = 'correct horse battery staple';
const replacement = 'updated horse battery staple';
const activeId = 'pages-active';
const automatedId = 'pages-automated';
const inactiveId = 'pages-inactive';
const accounts = new Map<string, AccessAccount>();
type Delivery = { accountId: string; email: string; token: string; expiresAt: Date; url: string };
const deliveries: Delivery[] = [];
let blockDelivery: (() => Promise<void>) | undefined;
let recoveryReceipt: { receiptId: string; accountId: string; minimumAuthnEpoch: number } | undefined;
let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let service: AuthService;
let drain = async () => {};

function trackQueries(target: Pool) {
  let inflight = 0;
  const query = target.query.bind(target);
  const connect = target.connect.bind(target) as {
    (): Promise<PoolClient>;
    (...args: unknown[]): void;
  };
  const tracked = (run: () => unknown) => {
    inflight++;
    try {
      return Promise.resolve(run()).finally(() => {
        inflight--;
      });
    } catch (error) {
      inflight--;
      throw error;
    }
  };
  // node-pg Pool.query checks out through callback connect. Replacing that
  // path with a promise leaves the callback uncalled and the query pending.
  const hasCallback = (args: unknown[]) => typeof args.at(-1) === 'function';
  const trackClient = (client: PoolClient) => {
    if (Object.hasOwn(client, 'trackedQuery')) return client;
    const clientQuery = client.query.bind(client);
    Object.defineProperty(client, 'trackedQuery', { value: true });
    client.query = ((...args: unknown[]) =>
      hasCallback(args)
        ? clientQuery(...(args as [string]))
        : tracked(() => clientQuery(...(args as [string])))) as PoolClient['query'];
    return client;
  };
  target.query = ((...args: unknown[]) =>
    hasCallback(args) ? query(...(args as [string])) : tracked(() => query(...(args as [string])))) as Pool['query'];
  target.connect = ((...args: unknown[]) =>
    hasCallback(args) ? connect(...args) : connect().then(trackClient)) as Pool['connect'];
  return async function settled() {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (inflight === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (inflight === 0) return;
      }
    }
  };
}
function blockNextDelivery() {
  let entered!: () => void;
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  blockDelivery = () => {
    blockDelivery = undefined;
    entered();
    return gate;
  };
  return { entered: opened, release: () => release() };
}
function request(path: string, body?: unknown, cookie = '') {
  return service.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function shot(response: Response) {
  const body = await response.text();
  const headers = [...response.headers.entries()]
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right) || 0);
  return { status: response.status, headers, body };
}
function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  drain = trackQueries(pool);
  const key = await generateKeyPair('ES256', { extractable: true });
  const signingKey = { ...(await exportJWK(key.privateKey)), kid: 'pages-recovery-signer', alg: 'ES256' };
  const options: AuthServiceOptions = {
    database: pool,
    issuer,
    audience: 'https://pages-recovery.api.test',
    secret: 'pages-recovery-better-auth-secret-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    recoveryDelivery: {
      async deliver(input) {
        const blocked = blockDelivery?.();
        deliveries.push({ ...input, expiresAt: new Date(input.expiresAt) });
        await blocked;
      },
    },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
      },
      async readAccount(id) {
        return accounts.get(id) ?? null;
      },
      async readRecoveryAccount(id) {
        return accounts.get(id) ?? null;
      },
      async authorizeProvisioning(id) {
        return { accountId: id };
      },
      async authorizeRecovery(input) {
        const account = accounts.get(input.accountId);
        if (!account || account.automated || input.proofEpoch !== account.authnEpoch) throw new Error('Stale recovery');
        account.authnEpoch += 1;
        recoveryReceipt = {
          receiptId: `recovery-${account.authnEpoch}`,
          accountId: account.accountId,
          minimumAuthnEpoch: account.authnEpoch,
        };
        return recoveryReceipt;
      },
      async completeRecovery(reference) {
        const witness = await service.internal.resolveRecoveryEstablishment(reference);
        if (
          !witness ||
          !recoveryReceipt ||
          witness.receiptId !== recoveryReceipt.receiptId ||
          witness.accountId !== recoveryReceipt.accountId ||
          witness.authnEpoch !== recoveryReceipt.minimumAuthnEpoch
        )
          throw new Error('Invalid completion');
      },
    }),
  };
  service = await createAuthService(options);
  await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: [] });
  for (const id of [activeId, automatedId, inactiveId]) {
    const account: AccessAccount = { accountId: id, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false };
    accounts.set(id, account);
    await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    account.state = 'active';
  }
  accounts.get(automatedId)!.automated = true;
  accounts.get(inactiveId)!.state = 'suspended';
}, 30000);

afterAll(async () => {
  await pool?.end();
  fixture?.close();
}, 30000);

test('recovery by email answers the same success, delivers one link, and completion resets the password', async () => {
  for (const body of [{ email: 'not-an-email' }, { account_id: activeId }, {}, { email: '' }]) {
    const invalid = await shot(await request('/recovery/start', body));
    expect(invalid.status).toBe(400);
    expect(invalid.body).toBe('{"error":"authentication_denied"}');
  }
  expect((await pool.query('SELECT key FROM auth_attempt_counter')).rows).toEqual([]);

  const unknown = await shot(await request('/recovery/start', { email: 'nobody@example.test' }));
  await drain();
  const automated = await shot(await request('/recovery/start', { email: `${automatedId}@example.test` }));
  await drain();
  const inactive = await shot(await request('/recovery/start', { email: `${inactiveId}@example.test` }));
  await drain();
  expect(deliveries).toHaveLength(0);
  expect(automated).toEqual(unknown);
  expect(inactive).toEqual(unknown);
  expect(unknown.status).toBe(200);
  expect(unknown.body).toBe('{"success":true}');
  expect(unknown.headers).toContainEqual(['cache-control', 'no-store']);
  expect(unknown.headers.some(([name]) => name === 'set-cookie')).toBe(false);

  const firstGate = blockNextDelivery();
  const active = await shot(await request('/recovery/start', { email: `${activeId}@example.test` }));
  expect(active).toEqual(unknown);
  await firstGate.entered;
  expect(deliveries).toHaveLength(1);
  firstGate.release();
  await drain();

  const cooled = await shot(await request('/recovery/start', { email: `${activeId}@example.test` }));
  expect(cooled).toEqual(unknown);
  await drain();
  expect(deliveries).toHaveLength(1);
  expect((await pool.query('SELECT proof_hash FROM auth_recovery WHERE account_id=$1', [activeId])).rows).toHaveLength(
    1,
  );

  await pool.query(`UPDATE auth_attempt_counter SET last_request = statement_timestamp() - interval '61 seconds'`);
  const secondGate = blockNextDelivery();
  const renewed = await shot(await request('/recovery/start', { email: `${activeId}@example.test` }));
  expect(renewed).toEqual(unknown);
  await secondGate.entered;
  secondGate.release();
  await drain();
  expect(deliveries).toHaveLength(2);

  const delivered = deliveries[0]!;
  const params = new URLSearchParams(new URL(delivered.url).hash.slice(1));
  expect(delivered.url).toBe(
    `${issuer}/recovery#account_id=${encodeURIComponent(delivered.accountId)}&token=${encodeURIComponent(delivered.token)}`,
  );
  expect(params.get('account_id')).toBe(activeId);
  expect(params.get('token')).toBe(delivered.token);
  expect(delivered.email).toBe(`${activeId}@example.test`);

  const signedIn = await request('/signin', {
    email: `${activeId}@example.test`,
    password,
    client_id: 'login',
    scope: [],
  });
  expect(signedIn.status).toBe(200);
  const session = cookieOf(signedIn);
  expect((await pool.query('SELECT id FROM session WHERE "userId"=$1', [activeId])).rows).toHaveLength(1);
  const completed = await shot(
    await request('/recovery/complete', {
      account_id: params.get('account_id'),
      token: params.get('token'),
      new_password: replacement,
    }),
  );
  expect(completed.status).toBe(200);
  expect(completed.body).toBe('{"success":true}');
  expect((await pool.query('SELECT id FROM session WHERE "userId"=$1', [activeId])).rows).toEqual([]);
  expect((await request('/session', undefined, session)).status).toBeGreaterThanOrEqual(400);
  expect(
    (
      await request('/signin', {
        email: `${activeId}@example.test`,
        password,
        client_id: 'login',
        scope: [],
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (
      await request('/signin', {
        email: `${activeId}@example.test`,
        password: replacement,
        client_id: 'login',
        scope: [],
      })
    ).status,
  ).toBe(200);
}, 30000);
