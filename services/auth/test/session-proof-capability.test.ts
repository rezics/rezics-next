import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { newId, routeOf } from '../../kernel/src/route/route.ts';
import { createAuthService, type AuthService, type EffectAuthorization, type SessionProof } from '../src/index.ts';

await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
let readAccount: typeof import('../../kernel/src/access/account-data.ts').readAccount;
let access: ReturnType<typeof import('../../kernel/src/access/index.ts').createAccess>;

const issuer = 'https://proof.auth.test';
const audience = 'https://proof.api.test';
const humanId = newId(0x9200);
const robotId = newId(0x9210);
const password = 'correct horse battery staple';
let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let service: AuthService;
let foreign: AuthService;
let headers: Headers;
let session: Record<string, unknown>;
let sequence = 0;
let callback: (proof: SessionProof) => Promise<void> = async () => {};
let saved: SessionProof;
let tokens: string[] = [];
let pauseQuery: ((sql: string) => Promise<void> | undefined) | undefined;
async function request(path: string, body?: unknown, cookie = '') {
  return service.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function opening() {
  return service.internal.openAutomatedSession({
    authorization: 'structural-boundary',
    subjectAccountId: robotId,
    headers,
  });
}

beforeAll(async () => {
  fixture = testDatabase();
  // Real installed Access authentication reads its own migrated account authority.
  migrateKernel(fixture.url);
  pool = new Pool({ connectionString: fixture.url });
  pool.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = ((...args: Parameters<typeof query>) => {
      const input = args[0] as string | { text: string };
      const sql = typeof input === 'string' ? input : input.text;
      const paused = pauseQuery?.(sql);
      return paused ? paused.then(() => query(...args)) : query(...args);
    }) as typeof client.query;
  });
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = fixture.url;
  try {
    ({ readAccount } = await import('../../kernel/src/access/account-data.ts'));
    const { createAccess } = await import('../../kernel/src/access/index.ts');
    access = createAccess({
      actions: new Map(),
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
      },
    });
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }

  for (const [id, operator] of [
    [humanId, null],
    [robotId, humanId],
  ] as const)
    await pool.query(
      `INSERT INTO access.account(route,account_id,kind,state,operator_account_id,transaction_id)
      VALUES ($1,$2,'actor','pending',$3,$4)`,
      [routeOf(id)!, id, operator, newId(routeOf(id)!)],
    );
  const key = await generateKeyPair('ES256', { extractable: true });
  const options = {
    database: pool,
    issuer,
    audience,
    secret: 'proof-only-persistent-secret-at-least-32-bytes',
    signing: { activeKid: 'proof-key', privateKeys: [{ ...(await exportJWK(key.privateKey)), kid: 'proof-key' }] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id: string) {
        return this.readAccount(id);
      },
      async readAccount(id: string) {
        const row = await readAccount(pool, routeOf(id)!, id);
        return (
          row && {
            accountId: id,
            kind: row.kind as 'actor' | 'organization',
            state: row.state as 'pending' | 'active' | 'suspended' | 'deleted',
            authnEpoch: Number(row.minimumAuthnEpoch),
            automated: row.operatorAccountId !== null,
            fenced: row.fenced,
          }
        );
      },
      async authorizeProvisioning(accountId: string) {
        return { accountId };
      },
      async consumeAuthorization(input: { human: SessionProof; purpose: EffectAuthorization['purpose'] }) {
        saved = input.human;
        await callback(input.human);
        // Structural effect fixture only: purpose/operator/resource policy needs native Access commands.
        return {
          receiptId: `proof-effect-${++sequence}`,
          subjectAccountId: robotId,
          actingHumanId: humanId,
          operatorAccountId: humanId,
          purpose: input.purpose,
          clientId: input.human.client_id,
          scopes: input.human.scope,
          humanEpoch: input.human.authn_epoch,
          subjectEpoch: 1,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      },
    }),
  };
  service = await createAuthService(options);
  foreign = await createAuthService(options);
  await service.internal.registerClient({ clientId: 'proof-web', firstParty: true, scopes: ['read', 'write'] });
  await service.internal.provisionPassword({ authorization: humanId, email: 'human@proof.test', password });
  await service.internal.provisionCredentialless({ authorization: robotId });
  await pool.query(`UPDATE access.account SET state='active'`);
  const login = await request('/signin', {
    email: 'human@proof.test',
    password,
    client_id: 'proof-web',
    scope: ['read'],
  });
  expect(login.status).toBe(200);
  headers = new Headers({
    cookie: login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });
  session = (await pool.query('SELECT * FROM session WHERE "userId"=$1', [humanId])).rows[0];
}, 60000);
afterAll(async () => {
  await pool?.end();
  fixture?.close();
});

test('only a live native human callback supplies the ordinary JWT to installed Access', async () => {
  const publicProof = (await (await request('/session', undefined, headers.get('cookie')!)).json()) as SessionProof;
  await expect(service.internal.accessTokenForProof(publicProof)).rejects.toThrow();
  callback = async (proof) => {
    expect(() => {
      proof.account_id = robotId;
    }).toThrow();
    expect(() => {
      proof.scope.push('write');
    }).toThrow();
    for (const copy of [{ ...proof }, JSON.parse(JSON.stringify(proof)), Object.assign(Object.create(proof), {})])
      await expect(service.internal.accessTokenForProof(copy)).rejects.toThrow();
    await expect(foreign.internal.accessTokenForProof(proof)).rejects.toThrow();
    const token = await service.internal.accessTokenForProof(proof);
    tokens.push(token);
    const jwks = await (await request('/.well-known/jwks.json')).json();
    const verified = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer,
      audience,
      algorithms: ['ES256'],
      typ: 'at+jwt',
    });
    expect(verified.protectedHeader).toEqual({ alg: 'ES256', kid: 'proof-key', typ: 'at+jwt' });
    const { iat, exp, ...claims } = verified.payload;
    expect(exp! - iat!).toBe(300);
    expect(claims).toEqual({
      iss: issuer,
      aud: audience,
      sub: humanId,
      client_id: proof.client_id,
      scope: proof.scope.join(' '),
      authn_epoch: proof.authn_epoch,
      auth_time: proof.auth_time,
      amr: proof.amr,
    });
    const actor = await access.authenticate(token, { pool, deadline: Date.now() + 2000 });
    expect(actor).toEqual({
      kind: 'account',
      accountId: humanId,
      clientId: proof.client_id,
      scopes: proof.scope,
      requestedBy: null,
      authnEpoch: proof.authn_epoch,
    });
    const ordinary = (await (await request('/token', {}, headers.get('cookie')!)).json()) as { access_token: string };
    const { iat: _iat, exp: _exp, ...ordinaryClaims } = decodeJwt(ordinary.access_token);
    expect(ordinaryClaims).toEqual(claims);
  };
  expect((await opening()).status).toBe(200);
  const old = saved;
  await expect(service.internal.accessTokenForProof(old)).rejects.toThrow();
  callback = async (proof) => {
    expect(proof).not.toBe(old);
    await expect(service.internal.accessTokenForProof(old)).rejects.toThrow();
  };
  expect((await opening()).status).toBe(200);
  callback = async () => {
    throw new Error('callback failure');
  };
  await expect(opening()).rejects.toThrow('callback failure');
  await expect(service.internal.accessTokenForProof(saved)).rejects.toThrow();
  expect((await request('/accessTokenForProof', { proof: publicProof })).status).toBe(404);
  const persisted = JSON.stringify((await pool.query('SELECT * FROM auth_effect_receipt')).rows);
  for (const token of tokens) expect(persisted).not.toContain(token);
});

test('live capability rechecks native source, client, consent and account barriers before signing', async () => {
  const cases: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
    [
      'epoch',
      () => pool.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE account_id=$1', [humanId]),
      () => pool.query('UPDATE session SET "authnEpoch"=2 WHERE id=$1', [session.id]),
    ],
    [
      'fence',
      () => pool.query('UPDATE access.account SET authn_fenced=true WHERE account_id=$1', [humanId]),
      () => pool.query('UPDATE access.account SET authn_fenced=false WHERE account_id=$1', [humanId]),
    ],
    [
      'state',
      () => pool.query(`UPDATE access.account SET state='suspended' WHERE account_id=$1`, [humanId]),
      () => pool.query(`UPDATE access.account SET state='active' WHERE account_id=$1`, [humanId]),
    ],
    [
      'automation',
      () => pool.query('UPDATE access.account SET operator_account_id=$2 WHERE account_id=$1', [humanId, robotId]),
      () => pool.query('UPDATE access.account SET operator_account_id=NULL WHERE account_id=$1', [humanId]),
    ],
    [
      'scope',
      () => pool.query(`UPDATE auth_client SET scopes=ARRAY['write'] WHERE client_id='proof-web'`),
      () => pool.query(`UPDATE auth_client SET scopes=ARRAY['read','write'] WHERE client_id='proof-web'`),
    ],
    [
      'consent',
      () =>
        pool
          .query(`UPDATE auth_client SET first_party=false WHERE client_id='proof-web'`)
          .then(() => pool.query('DELETE FROM auth_consent WHERE account_id=$1', [humanId])),
      () => pool.query(`UPDATE auth_client SET first_party=true WHERE client_id='proof-web'`),
    ],
    [
      'reduction',
      () =>
        service.internal.beginClientReduction({
          clientId: 'proof-web',
          operationId: 'proof-reduction',
          scopes: [],
          firstParty: true,
        }),
      () => pool.query(`DELETE FROM auth_client_reduction WHERE client_id='proof-web'`),
    ],
    [
      'source-scope',
      () => pool.query(`UPDATE session SET "grantedScope"='write' WHERE id=$1`, [session.id]),
      () => pool.query(`UPDATE session SET "grantedScope"='read' WHERE id=$1`, [session.id]),
    ],
    [
      'coverage',
      () => pool.query(`UPDATE auth_client_coverage SET ready=false WHERE client_id='proof-web'`),
      () => pool.query(`UPDATE auth_client_coverage SET ready=true WHERE client_id='proof-web'`),
    ],
    [
      'expiry',
      () => pool.query(`UPDATE session SET "expiresAt"='2000-01-01' WHERE id=$1`, [session.id]),
      () => pool.query('UPDATE session SET "expiresAt"=$2 WHERE id=$1', [session.id, session.expiresAt]),
    ],
    [
      'source',
      () => pool.query('DELETE FROM session WHERE id=$1', [session.id]),
      () =>
        pool.query(`INSERT INTO session SELECT * FROM json_populate_record(NULL::session,$1::json)`, [
          JSON.stringify({ ...session, authnEpoch: 2 }),
        ]),
    ],
  ];
  for (const [name, mutate, restore] of cases) {
    callback = async (proof) => {
      await mutate();
      try {
        await expect(service.internal.accessTokenForProof(proof), name).rejects.toThrow();
      } finally {
        await restore();
      }
      throw new Error(`checked ${name}`);
    };
    await expect(opening()).rejects.toThrow(`checked ${name}`);
    await expect(service.internal.accessTokenForProof(saved)).rejects.toThrow();
  }
  // An automated source is denied before the trusted effect callback is entered.
  await pool.query('UPDATE access.account SET operator_account_id=$2 WHERE account_id=$1', [humanId, robotId]);
  callback = async () => {
    throw new Error('must not enter');
  };
  await expect(opening()).rejects.toThrow('Authentication denied');
  await pool.query('UPDATE access.account SET operator_account_id=NULL WHERE account_id=$1', [humanId]);
  // An operator session cannot become human evidence by changing its account classification.
  await pool.query(`UPDATE session SET "authMethods"='operator' WHERE id=$1`, [session.id]);
  await expect(opening()).rejects.toThrow('Authentication denied');
  await pool.query(`UPDATE session SET "authMethods"='pwd' WHERE id=$1`, [session.id]);
});

test('source remaining lifetime caps JWT expiry and detached work cannot outlive the callback', async () => {
  const expiry = new Date(Date.now() + 45000);
  await pool.query('UPDATE session SET "expiresAt"=$2 WHERE id=$1', [session.id, expiry]);
  callback = async (proof) => {
    const claims = decodeJwt(await service.internal.accessTokenForProof(proof));
    expect(claims.exp).toBe(Math.floor(expiry.getTime() / 1000));
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(45);
  };
  expect((await opening()).status).toBe(200);
  let resume!: () => void;
  let detached!: Promise<string>;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  callback = async (proof) => {
    detached = gate.then(() => service.internal.accessTokenForProof(proof));
  };
  expect((await opening()).status).toBe(200);
  resume();
  await expect(detached).rejects.toThrow();
  await pool.query('UPDATE session SET "expiresAt"=$2 WHERE id=$1', [session.id, session.expiresAt]);
});

test('already-started signing loses authority on callback success or failure, including barrier release', async () => {
  for (const [statement, fail] of [
    ['auth_signing_generation', true],
    ['pg_advisory_unlock_shared', false],
  ] as const) {
    let resume!: () => void;
    let entered!: () => void;
    let pending!: Promise<string>;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    pauseQuery = (sql) => {
      if (!sql.includes(statement)) return;
      pauseQuery = undefined;
      entered();
      return gate;
    };
    callback = async (proof) => {
      pending = service.internal.accessTokenForProof(proof);
      await reached;
      if (fail) throw new Error('callback failed during signing');
    };
    try {
      if (fail) await expect(opening()).rejects.toThrow('callback failed during signing');
      else expect((await opening()).status).toBe(200);
    } finally {
      pauseQuery = undefined;
      resume();
    }
    await expect(pending).rejects.toThrow('Authentication denied');
  }
});
