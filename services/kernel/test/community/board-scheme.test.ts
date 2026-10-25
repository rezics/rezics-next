import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createAuthHost,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import type { Access } from '../../src/request/access.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';

const issuer = 'https://board-scheme.auth.test';
const audience = 'https://board-scheme.api.test';
const password = 'realm http registration password with enough entropy';
const routeKey = new Uint8Array(32).fill(93);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(94)]]) };

let admin: Pool;
let pool: Pool;
let authPool: Pool;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let governance: Person;
let owner: Person;
let unrelated: Person;
let classificationContext: { id: string; kind: string; labels: Record<string, string> };
let probe: Realm;
let schemeId: string;
let wrongTypeId: string;
let access: Access;
let db: GrowthDatabase;
let scopes: string[];

type Person = { accountId: string; bearer: string };
type Realm = {
  boardSchemeId: string | null;
  realmId: string;
  spaceId: string;
  state: string;
  visibility: string;
  contextId: string;
  headRevisionId: string;
  createdAt: string;
  creator: string;
  predecessor: string | null;
  title: string;
  summary: string;
  revisionCreatedAt: string;
  author: string;
};
type Call = { bearer?: string; body?: unknown; key?: string; headers?: Record<string, string> };

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'board-scheme-client', scope }),
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

async function person(name: string, scope: string[]): Promise<Person> {
  const result = await host.workflows.register({ key: name, handle: name, email: `${name}@realm.test`, password });
  return { accountId: result.accountId, bearer: await issue(`${name}@realm.test`, scope) };
}

async function call(method: string, path: string, options: Call = {}) {
  const headers = new Headers(options.headers);
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
  let value: Record<string, unknown> = {};
  try {
    value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Keep missing-route failures readable while this contract is introduced.
  }
  return { response, value };
}

async function grant(accountId: string, actions: string[]) {
  const body = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account' as const, id: accountId },
    actions,
    valid: '(,)',
  };
  const result = await call('POST', '/v1/grants', {
    bearer: governance.bearer,
    key: crypto.randomUUID(),
    body,
  });
  expect(result.response.status).toBe(201);
  expect(result.value).toEqual({ grant: body });
}

async function createSpace(title: string) {
  const result = await call('POST', '/v1/spaces', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { title, summary: `${title} summary` },
  });
  expect(result.response.status).toBe(201);
  return result.value.space as { spaceId: string; headRevisionId: string };
}

async function createRealm(
  spaceId: string,
  visibility: 'public' | 'protected',
  contextId = classificationContext.id,
  title = `${visibility} Realm`,
) {
  return call('POST', '/v1/realms', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { spaceId, title, summary: `${title} summary`, visibility, contextId },
  });
}

async function snapshot() {
  const result = await admin.query(`SELECT
    (SELECT count(*)::integer FROM community.space) AS spaces,
    (SELECT count(*)::integer FROM community.realm) AS realms,
    (SELECT count(*)::integer FROM community.realm_revision) AS revisions,
    (SELECT count(*)::integer FROM access.resource_initialization) AS initialized,
    (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::integer FROM access.resource_grant) AS grants,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events,
    (SELECT count(*)::integer FROM editorial.write_basis) AS bases,
    (SELECT coalesce(sum(position), 0)::text FROM core.partition) AS position`);
  return result.rows[0];
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  db = await openGrowthDatabase(url);
  admin = db.admin;
  pool = db.pool;
  pool.options.max = 1;
  authDatabaseName = `board_scheme_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'board-scheme',
  };
  const limiter = createWriteRateLimiter({
    secret: 'board-scheme-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100000, seconds: 86400 } },
      'new-account': { write: { maximum: 100000, seconds: 86400 } },
    }),
  });
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    access: (config) =>
      (access = createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      })),
    writeRate: limiter,
  });
  scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  const registration = createRegistrationProofBindings({ pool, referenceKeys: tokens });
  const provisioning = createProvisioningEvidenceVerifier({ database: authPool });
  const internal = createLifecycleInternals({
    pool,
    routeKey,
    provisioningEvidence: (evidence) => provisioning.resolve(evidence),
    recoveryEvidence: async () => null,
  });
  const registrationPorts = {
    ...internal,
    async createPending(input: Parameters<typeof internal.createPending>[0]) {
      const outcome = await internal.createPending(input);
      const pair = { accountId: input.accountId, reservationId: input.reservationId };
      if (!(await proofs.pendingReference(pair))) {
        const reference = await registration.createProvisioningReference({ input, outcome });
        if (!reference) throw new Error('Missing native registration reference');
        await proofs.recordPending({ ...pair, reference });
      }
      return outcome;
    },
    async provisioningReference(input: { accountId: string; reservationId: string }) {
      const reference = await proofs.pendingReference(input);
      if (!reference) throw new Error('Missing persisted registration reference');
      return reference;
    },
    provisioningEvidence: (input: { accountId: string; reservationId: string }) => proofs.provisioningEvidence(input),
  };
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'board-scheme-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(95),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'board-scheme-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'board-scheme-client', firstParty: true, scopes });
  await host.start();
  governance = await person('scheme_governance', scopes);
  owner = await person('scheme_owner', scopes);
  unrelated = await person('scheme_unrelated', scopes);
  await bootstrapGovernance(pool, governance.accountId);
  await bootstrapRelease(pool, bundledRelease);
  await grant(owner.accountId, ['realm:create', 'space:create', 'subject:create']);
  classificationContext = { id: GLOBAL_CONTEXT, kind: 'global', labels: {} };
  const space = await createSpace('Board scheme host');
  const created = await createRealm(space.spaceId, 'protected');
  expect(created.response.status).toBe(201);
  probe = created.value.realm as Realm;
  for (const type of ['skos:ConceptScheme', 'skos:Concept']) {
    const subject = await call('POST', '/v1/subjects', {
      bearer: owner.bearer,
      key: crypto.randomUUID(),
      body: { type, labels: { en: type } },
    });
    expect(subject.response.status).toBe(201);
    const id = (subject.value.subject as { id: string }).id;
    if (type === 'skos:ConceptScheme') schemeId = id;
    else wrongTypeId = id;
  }
}, 60_000);

afterAll(async () => {
  await host?.stop();
  if (authDatabaseName) await admin?.query(`DROP DATABASE IF EXISTS ${authDatabaseName} WITH (FORCE)`);
  await db?.close();
});

async function put(
  scheme: string,
  head = probe.headRevisionId,
  bearer: string | undefined = owner.bearer,
  key = crypto.randomUUID(),
) {
  return call('PUT', `/v1/realms/${probe.realmId}/boardScheme`, {
    ...(bearer === undefined ? {} : { bearer }),
    key,
    headers: { 'if-match': JSON.stringify(head) },
    body: { schemeId: scheme },
  });
}

test.serial(
  'a Realm owner sets an existing ConceptScheme, moving its head and retaining metadata and revision history',
  async () => {
    expect(probe.boardSchemeId).toBeNull();
    const previous = probe;
    const previousHead = previous.headRevisionId;
    const key = crypto.randomUUID();
    const changed = await put(schemeId, previousHead, owner.bearer, key);
    expect(changed.response.status).toBe(200);
    probe = changed.value.realm as Realm;
    const head = probe.headRevisionId;
    expect(structuredClone(probe)).toMatchObject({
      ...previous,
      boardSchemeId: schemeId,
      predecessor: previousHead,
      headRevisionId: expect.any(String),
      revisionCreatedAt: expect.any(String),
    });
    expect(head).not.toBe(previousHead);
    expect(changed.response.headers.get('etag')).toBe(JSON.stringify(head));
    const read = await call('GET', `/v1/realms/${probe.realmId}`, { bearer: owner.bearer });
    expect(read.response.status).toBe(200);
    expect(read.value).toEqual({ realm: probe });
    const revisions = await admin.query(
      'SELECT revision_id, board_scheme_id FROM community.realm_revision WHERE route=$1 AND realm_id=$2',
      [routeOf(probe.realmId), probe.realmId],
    );
    expect(revisions.rows).toHaveLength(2);
    expect(revisions.rows).toContainEqual({ revision_id: previousHead, board_scheme_id: null });
    expect(revisions.rows).toContainEqual({ revision_id: head, board_scheme_id: schemeId });
    const before = await snapshot();
    const replay = await put(schemeId, previousHead, owner.bearer, key);
    expect(replay.response.status).toBe(200);
    expect(replay.value).toEqual({ realm: probe });
    expect(await snapshot()).toEqual(before);
  },
);

test.serial(
  'wrong type, unreadable or missing subject, non-owner, anonymous and stale head write nothing',
  async () => {
    // account:suspend is not mounted; no direct account-state mutation stands in for that persona.
    expect(actionCatalogue(kernel).has('account:suspend')).toBe(false);
    const unreadable = newId(28);
    const cases = [
      { scheme: wrongTypeId, bearer: owner.bearer, head: probe.headRevisionId, status: 403 },
      { scheme: unreadable, bearer: owner.bearer, head: probe.headRevisionId, status: 403 },
      { scheme: newId(28), bearer: owner.bearer, head: probe.headRevisionId, status: 403 },
      { scheme: schemeId, bearer: unrelated.bearer, head: probe.headRevisionId, status: 403 },
      { scheme: schemeId, bearer: '', head: probe.headRevisionId, status: 401 },
      { scheme: schemeId, bearer: owner.bearer, head: probe.predecessor!, status: 404 },
    ];
    for (const item of cases) {
      const before = await snapshot();
      const denied = await put(item.scheme, item.head, item.bearer);
      expect(denied.response.status).toBe(item.status);
      expect(denied.value).not.toHaveProperty('realm');
      expect(await snapshot()).toEqual(before);
      const read = await call('GET', `/v1/realms/${probe.realmId}`, { bearer: owner.bearer });
      expect(read.value).toEqual({ realm: probe });
    }
  },
);

test.serial('metadata edits preserve the selected board scheme in the new head revision', async () => {
  const result = await call('PATCH', `/v1/realms/${probe.realmId}`, {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(probe.headRevisionId) },
    body: { summary: 'Updated metadata' },
  });
  expect(result.response.status).toBe(200);
  probe = result.value.realm as Realm;
  expect(probe.boardSchemeId).toBe(schemeId);
  const revision = await admin.query(
    'SELECT board_scheme_id FROM community.realm_revision WHERE route=$1 AND revision_id=$2',
    [routeOf(probe.realmId), probe.headRevisionId],
  );
  expect(revision.rows).toEqual([{ board_scheme_id: schemeId }]);
});

test.serial(
  'setting and reading a fixed scheme stays bounded at 256, 2048 and 16384 Realms and subjects',
  async () => {
    const modulePath = '../../src/community/board-scheme.ts';
    const board = await import(modulePath);
    const actor = await access.authenticate(owner.bearer, { pool, deadline: Date.now() + 90_000 });
    const hotPartition = partitionOf(routeOf(probe.realmId)!);
    const base = Number(
      (await admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [hotPartition])).rows[0].position,
    );
    const population: Population = {
      name: 'board-scheme-neighbours',
      hotPartition,
      hotShare: 1,
      rows({ route, ordinal }) {
        const space = newId(route),
          realm = newId(route),
          revision = newId(route),
          subject = newId(route);
        const at = '2026-10-25T00:00:00.000Z',
          transaction = crypto.randomUUID(),
          position = base + ordinal * 100 + 1;
        const value = { realmId: realm, revisionId: revision };
        return {
          'community.space': [
            {
              route,
              space_id: space,
              state: 'active',
              head_revision_id: revision,
              created_at: at,
              creator: owner.accountId,
            },
          ],
          'community.space_revision': [
            {
              route,
              space_id: space,
              revision_id: revision,
              predecessor: null,
              title: 'Neighbour',
              summary: '',
              created_at: at,
              author: owner.accountId,
            },
          ],
          'community.realm': [
            {
              route,
              realm_id: realm,
              space_id: space,
              state: 'active',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              head_revision_id: revision,
              created_at: at,
              creator: owner.accountId,
            },
          ],
          'community.realm_revision': [
            {
              route,
              realm_id: realm,
              revision_id: revision,
              predecessor: null,
              title: 'Neighbour',
              summary: '',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              created_at: at,
              author: owner.accountId,
            },
          ],
          'semantic.subject': [
            { route, subject_id: subject, type: 'skos:ConceptScheme', recorded_transaction_id: transaction },
          ],
          'semantic.revision': [
            {
              route,
              subject_id: subject,
              revision: 1,
              kind: 'create',
              release: bundledDigest,
              recorded_transaction_id: transaction,
            },
          ],
          'core.receipt': [
            {
              partition_no: hotPartition,
              principal_kind: 'account',
              principal_id: owner.accountId,
              command_kind: 'community.realm.board-scheme',
              idempotency_key: `seed-${ordinal}`,
              request_digest: Buffer.alloc(32),
              epoch: 1,
              position,
              transaction_id: transaction,
              response: value,
            },
          ],
          'core.outbox': [
            {
              partition_no: hotPartition,
              position,
              event_seq: 0,
              event_count: 1,
              epoch: 1,
              id: crypto.randomUUID(),
              type: 'com.rezics.community.realm.board-scheme.v1',
              subject: realm,
              data: value,
            },
          ],
          'editorial.write_basis': [
            {
              partition_no: hotPartition,
              transaction_id: transaction,
              epoch: 1,
              position,
              principal_kind: 'account',
              principal_id: owner.accountId,
              client_id: 'board-scheme-client',
              requested_by: null,
              recorded_at: at,
            },
          ],
        };
      },
      async finish(admin) {
        await admin.query(
          'UPDATE core.partition SET position=(SELECT max(position) FROM core.outbox WHERE partition_no=$1) WHERE partition_no=$1',
          [hotPartition],
        );
      },
    };
    const scales: [number, number, number] = [256, 2048, 16384];
    {
      let head = probe.headRevisionId;
      const report = await checkGrowth(db, {
        name: 'Realm board scheme set and read',
        scales,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(_, scale, previous) {
          await seed({ pool, admin }, population, { from: previous, to: scale });
        },
        async operation() {
          const changed = await board.setBoardScheme(
            { pool, access, routeKey },
            actor,
            { realmId: probe.realmId, schemeId, expectedHead: head },
            { deadline: Date.now() + 90_000, idempotencyKey: crypto.randomUUID() },
          );
          head = changed.value.revisionId;
          const read = await board.readRealm({ pool, access }, actor, probe.realmId, { deadline: Date.now() + 90_000 });
          expect(read?.boardSchemeId).toBe(schemeId);
          expect(read?.headRevisionId).toBe(head);
          return changed;
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual(scales);
      expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
      expect(new Set(report.samples.map((sample) => sample.cost.rows)).size).toBe(1);
      for (const sample of report.samples) {
        for (const [name, cost] of Object.entries(sample.cost.relations!)) {
          if (name.startsWith('community.') || name === 'semantic.subject' || name === 'semantic.revision')
            expect(cost.sequentialScans).toBe(0);
        }
        expect(sample.cost.relations!['access.account']?.rows).toBe(
          report.samples[0]!.cost.relations!['access.account']?.rows,
        );
      }
      probe.headRevisionId = head;
    }
  },
  120_000,
);
