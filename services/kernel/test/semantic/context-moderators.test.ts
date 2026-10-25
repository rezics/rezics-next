import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createAccess, type AccessConfig } from '../../src/access/index.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const accounts = {
  owner: '019a1b2c-3d4e-7f00-8a00-c047e0000001',
  moderator: '019a1b2c-3d4e-7f00-8a00-c047e0000002',
  outsider: '019a1b2c-3d4e-7f00-8a00-c047e0000003',
  third: '019a1b2c-3d4e-7f00-8a00-c047e0000004',
};
type AccountName = keyof typeof accounts;
const actions = [
  'access:grant',
  'context:create',
  'context:read',
  'context:accept',
  'context:adopt',
  'subject:create',
  'subject:read',
  'statement:propose',
];
let bearerTokens: Record<AccountName, string>;
let jwk: Record<string, unknown>;
const auth = {
  issuer: 'https://auth.example.test',
  audience: 'https://api.rezics.test',
  jwksUrl: 'https://auth.example.test/jwks',
  fetch: async () => Response.json({ keys: [jwk] }),
};
const kernel = createKernel({
  pool,
  access: (config: AccessConfig) => createAccess({ ...config, auth }),
  tokens,
  routeKey: new Uint8Array(32).fill(4),
  writeRate: {
    async spend() {
      return { allowed: true as const };
    },
  },
});

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  const signing = await generateKeyPair('ES256', { extractable: true });
  jwk = { ...(await exportJWK(signing.publicKey)), kid: 'context-moderators', alg: 'ES256' };
  bearerTokens = {
    owner: await signedToken(accounts.owner, signing.privateKey),
    moderator: await signedToken(accounts.moderator, signing.privateKey),
    outsider: await signedToken(accounts.outsider, signing.privateKey),
    third: await signedToken(accounts.third, signing.privateKey),
  };
  for (const id of Object.values(accounts))
    await admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  for (const action of ['context:create', 'subject:create', 'statement:propose'])
    await admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES (0,$1,$2,$3,'(,)',$2)`,
      [GLOBAL_CONTEXT, accounts.owner, action],
    );
}, 60_000);

async function signedToken(accountId: string, key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']) {
  return new SignJWT({
    client_id: 'web',
    scope: actions.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'context-moderators', typ: 'at+jwt' })
    .setIssuer(auth.issuer)
    .setAudience(auth.audience)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

async function call(method: string, path: string, options: { token?: AccountName; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${bearerTokens[options.token]}`;
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

const key = () => `"${randomUUID()}"`;
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});

function moderatorGrant(contextId: string, accountId: string) {
  return {
    resource: { route: routeOf(contextId)!, id: contextId },
    subject: { kind: 'account' as const, id: accountId },
    role: 'semantic.context.moderator',
    valid: '(,)',
  };
}

async function createContext(label: string) {
  const created = await call('POST', '/v1/contexts', {
    token: 'owner',
    key: key(),
    body: { labels: { en: label } },
  });
  expect(created.response.status).toBe(201);
  return created.body.context.id as string;
}

async function createBook() {
  const created = await call('POST', '/v1/subjects', {
    token: 'owner',
    key: key(),
    body: {
      type: 'schema:Book',
      labels: { en: 'Kokoro' },
      statements: {
        'schema:url': [statement('schema:url', 'https://example.org/kokoro')],
        'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
      },
    },
  });
  expect(created.response.status).toBe(201);
  const subject = created.body.subject;
  return {
    id: subject.id as string,
    first: subject.statements['schema:url'][0].id as string,
    second: subject.statements['schema:inLanguage'][0].id as string,
  };
}

async function accept(subjectId: string, candidate: string, contextId: string, token: AccountName) {
  return call('POST', `/v1/subjects/${subjectId}/candidates/${candidate}:accept`, {
    token,
    key: key(),
    body: { context: contextId, expected_head: null },
  });
}

async function grants(contextId: string) {
  const roles = await admin.query(
    `SELECT subject_kind, subject_id, subject_role, grant_role
     FROM access.resource_role_grant WHERE resource_id = $1
     ORDER BY subject_kind, subject_id, subject_role, grant_role`,
    [contextId],
  );
  const actions = await admin.query(
    `SELECT subject_kind, subject_id, subject_role, action
     FROM access.resource_grant WHERE resource_id = $1
     ORDER BY subject_kind, subject_id, subject_role, action`,
    [contextId],
  );
  return { roles: roles.rows, actions: actions.rows };
}

async function editorial(subjectId: string, contextId: string) {
  const revisions = await admin.query(
    'SELECT revision, kind FROM semantic.revision WHERE subject_id = $1 ORDER BY revision',
    [subjectId],
  );
  const acceptances = await admin.query(
    `SELECT context_id, candidate_id, head, verdict, revision
     FROM semantic.acceptance WHERE subject_id = $1 AND context_id = $2
     ORDER BY candidate_id, head`,
    [subjectId, contextId],
  );
  const current = await admin.query(
    `SELECT context_id, candidate_id, head, verdict, revision
     FROM semantic.acceptance_current WHERE subject_id = $1 AND context_id = $2
     ORDER BY candidate_id`,
    [subjectId, contextId],
  );
  return {
    revisions: revisions.rows,
    acceptances: acceptances.rows,
    current: current.rows,
    ...(await grants(contextId)),
  };
}

test('a Context owner grants and revokes the moderator role', async () => {
  const contextId = await createContext('Moderated readers');
  const book = await createBook();
  const grant = moderatorGrant(contextId, accounts.moderator);
  const granted = await call('POST', '/v1/roleGrants', { token: 'owner', key: key(), body: grant });
  expect([granted.response.status, granted.body]).toEqual([201, { grant }]);

  const accepted = await accept(book.id, book.first, contextId, 'moderator');
  expect(accepted.response.status).toBe(200);
  expect(accepted.body.acceptance).toEqual({
    context: contextId,
    candidate: book.first,
    decision: 'accept',
    head: 1,
  });

  const revoked = await call('POST', '/v1/roleGrants:revoke', { token: 'owner', key: key(), body: grant });
  expect([revoked.response.status, revoked.body]).toEqual([200, { grant }]);

  const before = await editorial(book.id, contextId);
  const denied = await accept(book.id, book.second, contextId, 'moderator');
  expect([denied.response.status, denied.body.code]).toEqual([403, 'forbidden']);
  expect(denied.body).not.toHaveProperty('acceptance');
  expect(await editorial(book.id, contextId)).toEqual(before);
});

test('a Context moderator or an outsider cannot grant a Context role', async () => {
  const contextId = await createContext('Closed readers');
  const grant = moderatorGrant(contextId, accounts.moderator);
  const granted = await call('POST', '/v1/roleGrants', { token: 'owner', key: key(), body: grant });
  expect([granted.response.status, granted.body]).toEqual([201, { grant }]);

  const before = await grants(contextId);
  const fromModerator = moderatorGrant(contextId, accounts.third);
  const moderatorDenied = await call('POST', '/v1/roleGrants', {
    token: 'moderator',
    key: key(),
    body: fromModerator,
  });
  expect([moderatorDenied.response.status, moderatorDenied.body.code]).toEqual([403, 'forbidden']);
  expect(moderatorDenied.body).not.toHaveProperty('grant');

  const fromOutsider = moderatorGrant(contextId, accounts.third);
  const outsiderDenied = await call('POST', '/v1/roleGrants', {
    token: 'outsider',
    key: key(),
    body: fromOutsider,
  });
  expect([outsiderDenied.response.status, outsiderDenied.body.code]).toEqual([403, 'forbidden']);
  expect(outsiderDenied.body).not.toHaveProperty('grant');
  expect(await grants(contextId)).toEqual(before);
});
