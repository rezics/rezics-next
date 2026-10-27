import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import {
  bootstrapGovernance,
  PLATFORM_GOVERNANCE_ROLE,
  PLATFORM_RESOURCE,
} from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

const issuer = 'https://governance-actions.auth.test';
const audience = 'https://governance-actions.api.test';
const password = 'governance actions registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };
const semanticRoots = ['/v1/subjects', '/v1/contexts', '/v1/definitions'];
const semanticOperationPrefixes = ['subject.', 'statement.', 'context.', 'definitions.'];
const foreignSubjectOperationIds = new Set([
  'subject.set_reaction',
  'subject.clear_reaction',
  'subject.get_own_reaction',
]);
const semanticWrites = [
  'statement:propose',
  'context:accept',
  'context:adopt',
  'subject:merge',
  'moderation:hide',
  'moderation:takedown',
];
const reference = {
  parts: [
    {
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://www.aozora.gr.jp/cards/000148/card773.html' },
    },
  ],
};

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const admin = new Pool({ connectionString: url });
const pool = createPool(url);
pool.options.max = 1;

let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let operator: { accountId: string; bearer: string };
let delegate: { accountId: string; bearer: string };
let stranger: { accountId: string; bearer: string };

type Call = { bearer?: string; body?: unknown; key?: string };
type Answer = { response: Response; value: Record<string, any> };

function underSemantic(path: string): boolean {
  return semanticRoots.some((root) => path === root || path.startsWith(`${root}/`));
}

function isSemanticOperation(route: (typeof kernel.routes)[number]): boolean {
  const operationId = route.hooks?.detail?.operationId;
  const action = route.hooks?.detail?.['x-action'];
  return (
    underSemantic(route.path) &&
    typeof operationId === 'string' &&
    action !== 'reaction:set' &&
    // Content reaction routes share the subject operationId namespace.
    !foreignSubjectOperationIds.has(operationId) &&
    semanticOperationPrefixes.some((prefix) => operationId.startsWith(prefix))
  );
}

function anonymous(action: string, catalogue: ReturnType<typeof actionCatalogue>): boolean {
  return catalogue.get(action)?.anonymous === true;
}

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'governance-actions-client', scope }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function person(name: string, scope: string[]) {
  const result = await host.workflows.register({ key: name, handle: name, email: `${name}@governance.test`, password });
  return { accountId: result.accountId, bearer: await issue(`${name}@governance.test`, scope) };
}

async function call(method: string, path: string, options: Call = {}): Promise<Answer> {
  const headers = new Headers();
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  return { response, value: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

function succeeded(answer: Answer, status: number, body: Record<string, unknown>) {
  expect({ status: answer.response.status, body: answer.value }).toEqual({ status, body });
}

async function createSubject(bearer: string, name: string) {
  const answer = await call('POST', '/v1/subjects', {
    bearer,
    key: crypto.randomUUID(),
    body: { type: 'schema:Person', labels: { en: name } },
  });
  expect(answer.response.status).toBe(201);
  expect(answer.value.subject).toMatchObject({ type: 'schema:Person', labels: { en: name } });
  return answer.value.subject.id as string;
}

async function propose(bearer: string, id: string, content: string) {
  const answer = await call('POST', `/v1/subjects/${id}/candidates`, {
    bearer,
    key: crypto.randomUUID(),
    body: {
      statement: {
        property: { id: 'schema:url' },
        value: { type: 'value', content },
        references: [reference],
      },
    },
  });
  expect(answer.response.status).toBe(201);
  expect(answer.value.candidate).toEqual(expect.any(String));
  return answer.value.candidate as string;
}

async function accept(bearer: string, id: string, candidate: string) {
  const answer = await call('POST', `/v1/subjects/${id}/candidates/${candidate}:accept`, {
    bearer,
    key: crypto.randomUUID(),
    body: { context: GLOBAL_CONTEXT, expected_head: null },
  });
  expect(answer.response.status).toBe(200);
  expect(answer.value.acceptance).toEqual({ context: GLOBAL_CONTEXT, candidate, decision: 'accept', head: 1 });
}

async function adopt(bearer: string, id: string, candidate: string) {
  const selection = [{ candidate, rank: 'normal' }];
  const answer = await call('POST', `/v1/subjects/${id}:adopt`, {
    bearer,
    key: crypto.randomUUID(),
    body: { context: GLOBAL_CONTEXT, property: 'schema:url', mode: 'replace', selection, expected_head: null },
  });
  expect(answer.response.status).toBe(200);
  expect(answer.value.adoption).toEqual({
    context: GLOBAL_CONTEXT,
    property: 'schema:url',
    mode: 'replace',
    selection,
    head: 1,
  });
}

async function merge(bearer: string, left: string, right: string) {
  const [survivor, redirected] = left < right ? [left, right] : [right, left];
  const answer = await call('POST', '/v1/subjects:merge', {
    bearer,
    key: crypto.randomUUID(),
    body: { subjects: [left, right] },
  });
  succeeded(answer, 200, { survivor, redirected, revision: 2 });
}

async function catalogueState() {
  const result = await admin.query(`SELECT
    (SELECT count(*)::integer FROM semantic.subject) AS subjects,
    (SELECT count(*)::integer FROM semantic.revision) AS revisions,
    (SELECT count(*)::integer FROM semantic.candidate) AS candidates,
    (SELECT count(*)::integer FROM semantic.acceptance) AS acceptances,
    (SELECT count(*)::integer FROM semantic.adoption) AS adoptions,
    (SELECT count(*)::integer FROM semantic.redirect) AS redirects,
    (SELECT count(*)::integer FROM semantic.fact) AS facts,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events,
    (SELECT count(*)::integer FROM editorial.write_basis) AS bases,
    (SELECT coalesce(sum(position), 0)::text FROM core.partition) AS position`);
  return result.rows[0];
}

beforeAll(async () => {
  authDatabaseName = `governance_actions_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'governance-actions',
  };
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      }),
    writeRate: createWriteRateLimiter({
      secret: 'governance-actions-write-rate-secret-32',
      overrides: JSON.stringify({
        anonymous: { write: { maximum: 100000, seconds: 86400 } },
        'new-account': { write: { maximum: 100000, seconds: 86400 } },
      }),
    }),
  });
  // Auth refuses to register the mounted media completion scope on this client.
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  const registration = createRegistrationProofBindings({ pool, referenceKeys: tokens });
  const { ports: registrationPorts } = createRegistrationPorts({
    pool,
    authPool,
    routeKey,
    referenceKeys: tokens,
  });
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'governance-actions-auth-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(73),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'governance-actions-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'governance-actions-client', firstParty: true, scopes });
  await host.start();
  operator = await person('gov_operator', scopes);
  delegate = await person('gov_delegate', scopes);
  stranger = await person('gov_stranger', scopes);
  await bootstrapGovernance(pool, operator.accountId);
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
}, 60_000);

afterAll(async () => {
  await host?.stop();
  if (!host && authPool) await authPool.end();
  if (authDatabaseName) await dropTestDatabase(admin, authDatabaseName);
  await pool.end();
  await admin.end();
});

test('platform governance holds every semantic write action', () => {
  const kernel = createKernel({ pool, routeKey: new Uint8Array(32) });
  const catalogue = actionCatalogue(kernel);
  const governance = resolveResourceRoles(catalogue).roles.get(PLATFORM_GOVERNANCE_ROLE);
  const semanticRoutes = kernel.routes.filter(isSemanticOperation);
  const semanticOperationIds = semanticRoutes
    .map((route) => route.hooks?.detail?.operationId)
    .filter((operationId): operationId is string => typeof operationId === 'string');
  const excludedForeignOperationIds = kernel.routes
    .flatMap((route) => {
      const operationId = route.hooks?.detail?.operationId;
      if (!underSemantic(route.path) || isSemanticOperation(route) || typeof operationId !== 'string') return [];
      return [operationId];
    })
    .sort();
  const writes = [
    ...new Set(
      semanticRoutes.flatMap((route) => {
        const action = route.hooks?.detail?.['x-action'];
        if (typeof action !== 'string' || action.endsWith(':read') || anonymous(action, catalogue)) return [];
        return [action];
      }),
    ),
  ].sort();
  expect(semanticOperationIds).toEqual(
    expect.arrayContaining(['subject.create', 'statement.hide', 'context.create', 'definitions.publish']),
  );
  expect(writes).toEqual(expect.arrayContaining(semanticWrites));
  expect(writes).not.toContain('reaction:set');
  expect(writes).not.toContain('rating:vote');
  expect(writes).not.toContain('collection:read');
  expect(excludedForeignOperationIds).toEqual(
    expect.arrayContaining([
      'subject.set_reaction',
      'subject.clear_reaction',
      'subject.get_own_reaction',
      'rating.vote_put',
      'rating.vote_delete',
      'subject_collection.list',
    ]),
  );
  expect(governance).toEqual(expect.arrayContaining(writes));
});

test('the bootstrapped governance account merges, accepts, adopts and delegates them through the API', async () => {
  const first = await createSubject(operator.bearer, 'Governance subject one');
  const second = await createSubject(operator.bearer, 'Governance subject two');
  const candidate = await propose(operator.bearer, first, 'https://example.org/governance/one');
  await accept(operator.bearer, first, candidate);
  await adopt(operator.bearer, first, candidate);
  await merge(operator.bearer, first, second);

  const left = await createSubject(operator.bearer, 'Delegated subject one');
  const right = await createSubject(operator.bearer, 'Delegated subject two');
  const pendingSubject = await createSubject(operator.bearer, 'Delegated acceptance');
  const pending = await propose(operator.bearer, pendingSubject, 'https://example.org/governance/delegated');
  const grant = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account' as const, id: delegate.accountId },
    actions: ['context:accept', 'subject:merge'],
    valid: '(,)',
  };
  const granted = await call('POST', '/v1/grants', {
    bearer: operator.bearer,
    key: 'governance-semantic-grant',
    body: grant,
  });
  succeeded(granted, 201, { grant });
  await merge(delegate.bearer, left, right);
  await accept(delegate.bearer, pendingSubject, pending);

  const blockedLeft = await createSubject(operator.bearer, 'Ungranted subject one');
  const blockedRight = await createSubject(operator.bearer, 'Ungranted subject two');
  const blockedSubject = await createSubject(operator.bearer, 'Ungranted acceptance');
  const blocked = await propose(operator.bearer, blockedSubject, 'https://example.org/governance/ungranted');
  const before = await catalogueState();
  const deniedMerge = await call('POST', '/v1/subjects:merge', {
    bearer: stranger.bearer,
    key: crypto.randomUUID(),
    body: { subjects: [blockedLeft, blockedRight] },
  });
  expect(deniedMerge.response.status).toBe(403);
  expect(deniedMerge.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(deniedMerge.value).not.toHaveProperty('survivor');
  const deniedAccept = await call('POST', `/v1/subjects/${blockedSubject}/candidates/${blocked}:accept`, {
    bearer: stranger.bearer,
    key: crypto.randomUUID(),
    body: { context: GLOBAL_CONTEXT, expected_head: null },
  });
  expect(deniedAccept.response.status).toBe(403);
  expect(deniedAccept.value).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(deniedAccept.value).not.toHaveProperty('acceptance');
  expect(await catalogueState()).toEqual(before);
});
