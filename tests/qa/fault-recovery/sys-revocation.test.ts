import { expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { sourceAcquisitionServices } from '../../../services/main/src/modules/source/acquisition.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import type { LicenseScopeHook } from '../../../services/main/src/modules/export/planner.ts';
import { exportRoutes } from '../../../services/main/src/routes/exports.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { semanticRoutes } from '../../../services/main/src/routes/semantic.ts';
import { PackageInstallationStore, type HookExecutor }
  from '../../../services/main/src/modules/package/install.ts';
import { PackageArtifactStore } from '../../../services/main/src/modules/package/lock-artifacts.ts';
import { PackageLockStore } from '../../../services/main/src/modules/package/lock.ts';
import { NpmResolutionStore } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { npmRegistryRequest } from '../fixtures/npm-registry-scenarios.ts';
import { archiveNpmFetcher, packageFiles, type ArchiveRegistry } from '../integration/package-install-fixtures.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const requiredEnv = ['REZICS_QA_RUN_ID', 'ACCOUNT_DATABASE_URL', 'ACCOUNT_SECRET', 'ACCOUNT_MAIN_RESOURCE',
  'ACCESS_DATABASE_URL', 'CONTENT_DATABASE_URL', 'FUSEKI_URL', 'MAIN_DATA_EPOCH', 'MAIN_ROUTING_EPOCH',
  'MAIN_S3_ENDPOINT', 'MAIN_S3_BUCKET', 'MAIN_S3_ACCESS_KEY', 'MAIN_S3_SECRET_KEY'] as const;

interface Gate {
  entered: Promise<void>;
  enter(): void;
  wait: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let enter!: () => void;
  let release!: () => void;
  return { entered: new Promise<void>(resolveEntered => { enter = resolveEntered; }),
    enter: () => enter(), wait: new Promise<void>(resolveWait => { release = resolveWait; }),
    release: () => release() };
}

let account: Awaited<ReturnType<typeof ratingAccount>>;
let contentPool: Pool;
let accessPool: Pool;
let principalId: string;
let actor: string;
let activePrincipalChecks = 0;
let app: ReturnType<typeof createMainApp>;
let exportApp: ReturnType<typeof exportRoutes>;
let semanticApp: ReturnType<typeof semanticRoutes>;
let scratch: string;
let sourceGate: Gate | null = null;
let exportGate: Gate | null = null;
let installGate: Gate | null = null;
let sourceFetches = 0;

async function setPrincipalActive(active: boolean): Promise<void> {
  await accessPool.query('UPDATE access.principal SET active = $2 WHERE id = $1', [principalId, active]);
}

async function routeApi(target: { handle: (request: Request) => Promise<Response> }, method: string,
  path: string, body?: unknown, key?: string): Promise<Response> {
  return target.handle(new Request(`http://main.local${path}`, { method, headers: {
    authorization: `Bearer ${account.tokenA}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(key ? { 'idempotency-key': key } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

const api = (method: string, path: string, body?: unknown, key?: string) =>
  routeApi(app, method, path, body, key);

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  expect({ status: response.status, text: response.status === status ? '' : text }).toEqual({ status, text: '' });
  return JSON.parse(text) as T;
}

async function permit(scope: string, action: string): Promise<void> {
  await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
  await accessPool.query(`INSERT INTO access.representation
    (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
  await accessPool.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
}

beforeAll(async () => {
  for (const name of requiredEnv) if (!Bun.env[name]) throw new Error('Run through the isolated fault/recovery QA tier');
  contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 8 });
  accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 6 });
  await migrateContent(contentPool);
  account = await ratingAccount(Bun.env as Record<string, string>,
    'openid work:edit work:read source:acquire source:read export:create export:read '
      + 'package:resolve package:verify package:install package:read');
  scratch = await mkdtemp(join(root, '.temp', 'sys-revocation-'));
  principalId = randomUUID();
  actor = `https://rezics.com/id/${randomUUID()}`;
  await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, $2, $3)`, [principalId, account.issuer, account.a.id]);
  await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
  // Source acquisition keeps G-508's catalogue creation ceiling. This fixture
  // supplies that authority before testing its withdrawal during provider work.
  await permit('work:create:root', 'work.create');

  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN,
    Bun.env.FUSEKI_COMMAND_TOKEN);
  const environment = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!,
    routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! }, objectDirectory: scratch };
  const providerFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    expect(init.redirect).toBe('manual');
    expect(String(input)).toMatch(/^https:\/\/openlibrary\.org\/works\/OL121W\.json$/);
    sourceFetches++;
    const pending = sourceGate;
    if (pending) {
      sourceGate = null;
      pending.enter();
      await pending.wait;
    }
    return new Response(JSON.stringify({ key: '/works/OL121W', title: 'SYS06 source',
      type: { key: '/type/work' }, revision: 1 }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const sourceAcquisitions = sourceAcquisitionServices(contentPool,
    { reserve: async () => {}, fetcher: providerFetch });
  const exports = new ExportStore(contentPool);
  const exportRights: LicenseScopeHook = async (members, useScope) => {
    const pending = exportGate;
    if (pending) {
      exportGate = null;
      pending.enter();
      await pending.wait;
    }
    return [{ basisKind: 'unprotected_fact', basisRef: null, licenseExpression: null, notice: null,
      obligations: [], useScope, result: 'undetermined',
      memberOrdinals: members.map((_, index) => index + 1) }];
  };

  const registry: ArchiveRegistry = { packages: { hooked: { versions: { '1.0.0': {
    scripts: { postinstall: 'node build.js' }, installScript: true,
    entries: packageFiles('hooked', '1.0.0', [], { postinstall: 'node build.js' }),
  } } } }, tamper: new Set(), missing: new Set() };
  const provider = archiveNpmFetcher(registry);
  const namespaces = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
  await namespaces('package/artifact/public/').initialize();
  const npm = new NpmResolutionStore(contentPool, { fetcher: provider.fetcher });
  const locks = new PackageLockStore(contentPool, npm, new PackageArtifactStore(contentPool, namespaces),
    { fetcher: provider.fetcher });
  const hookExecutor: HookExecutor = { profile: 'sys06-blocking-hook-v1', run: async input => {
    const pending = installGate;
    if (pending) {
      installGate = null;
      pending.enter();
      await pending.wait;
    }
    await writeFile(join(input.directory, 'built.txt'), input.hooks.join(','));
  } };
  const packageInstallations = new PackageInstallationStore(contentPool, locks,
    { rootDirectory: scratch, hookExecutor });
  const accessRegistry = new AccessAdmissionRegistry(accessPool);
  const access = new Proxy(accessRegistry, { get(target, property) {
    if (property === 'activePrincipalId') {
      return async (...args: Parameters<typeof accessRegistry.activePrincipalId>) => {
        activePrincipalChecks++;
        return accessRegistry.activePrincipalId(...args);
      };
    }
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as AccessAdmissionRegistry;
  const work = { environment, account: account.verifier, access,
    actingContexts: new AccessActingContexts(accessPool),
    sourceAcquisitions, exports, exportRights, packageNpmResolutions: npm, packageLocks: locks,
    packageInstallations } as MainWorkDependencies;
  app = createMainApp(fuseki, work);
  exportApp = exportRoutes(work);
  semanticApp = semanticRoutes(fuseki, work);
});

afterAll(async () => {
  await Promise.all([account?.close(), accessPool?.end(), contentPool?.end()].filter(Boolean));
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test('SYS06: revocation during source acquisition withholds delivery and replays the frozen result', async () => {
  await setPrincipalActive(true);
  const pendingGate = gate();
  sourceGate = pendingGate;
  const key = `sys06-source-${randomUUID()}`;
  const body = { profile: 'open-library-works-run-v1', workIds: ['OL121W'],
    editions: false, ratings: false, frontier: false };
  activePrincipalChecks = 0;
  const acquisition = api('POST', '/v1/sources/acquisitions', body, key);
  try {
    let providerStarted = false;
    await Promise.race([
      pendingGate.entered.then(() => { providerStarted = true; }),
      acquisition.then(async response => {
        if (!providerStarted) throw new Error(`acquisition ended before provider: ${response.status} ${await response.text()}`);
      }),
    ]);
    await setPrincipalActive(false);
    pendingGate.release();
    const response = await acquisition;
    const responseBody = await response.text();
    expect({ status: response.status, body: response.status === 403 ? '' : responseBody }).toEqual({ status: 403, body: '' });
    expect(activePrincipalChecks).toBe(2);

    const durable = await contentPool.query<{ id: string; outcome: string }>(`SELECT r.id, c.outcome
      FROM source.acquisition_run r JOIN source.acquisition_run_completion c ON c.run_id = r.id
      WHERE r.principal_id = $1 AND r.idempotency_key = $2`, [principalId, key]);
    expect(durable.rows).toEqual([{ id: expect.any(String), outcome: 'completed' }]);
    activePrincipalChecks = 0;
    expect((await api('GET', `/v1/sources/runs/${durable.rows[0]!.id}`)).status).toBe(403);
    expect(activePrincipalChecks).toBe(1);

    await setPrincipalActive(true);
    activePrincipalChecks = 0;
    const replay = await json<{ replayed: boolean }>(await api('POST', '/v1/sources/acquisitions', body, key), 200);
    expect(replay.replayed).toBe(true);
    expect(activePrincipalChecks).toBe(2);
    expect(sourceFetches).toBe(1);
  } finally {
    pendingGate.release();
    sourceGate = null;
    await setPrincipalActive(true);
  }
}, 60_000);

test('SYS06: export delivery revoked during source revalidation returns no private manifest', async () => {
  await setPrincipalActive(true);
  const componentScope = 'semantic:create:root';
  await permit(componentScope, 'semantic.change');
  const semantic = await json<{ component: string; revision: string; sourcePosition: { dataEpoch: string; sequence: string } }>(
    await routeApi(semanticApp, 'POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', actingSubject: actor,
      expectedHead: null, state: { component: 'resource', types: ['https://schema.org/Thing'],
        properties: [{ predicate: 'https://example.org/vocab/sys06',
          value: { kind: 'language-string', lexical: 'private export source', language: 'en', direction: 'ltr' } }] } },
    `sys06-semantic-${randomUUID()}`), 201);
  await permit(`semantic:read:${semantic.component}`, 'semantic.read');
  await permit(`export:${semantic.revision}`, 'export.create');
  const selection = { kind: 'semantic-revision', reference: semantic.revision, resource: semantic.component,
    expectedPosition: { dataEpoch: semantic.sourcePosition.dataEpoch,
      sequence: semantic.sourcePosition.sequence } };
  const created = await json<{ manifestId: string; manifestDigest: string }>(await routeApi(exportApp, 'POST', '/v1/exports', {
    profile: 'export-create-v1', actingSubject: actor, useScope: 'evaluation', selection,
  }, `sys06-export-${randomUUID()}`), 201);

  const pendingGate = gate();
  exportGate = pendingGate;
  activePrincipalChecks = 0;
  const delivery = routeApi(exportApp, 'GET', `/v1/exports/${created.manifestId}`);
  try {
    await pendingGate.entered;
    await setPrincipalActive(false);
    pendingGate.release();
    const response = await delivery;
    const responseBody = await response.text();
    expect({ status: response.status, leaksDigest: responseBody.includes(created.manifestDigest) })
      .toEqual({ status: 403, leaksDigest: false });
    expect(activePrincipalChecks).toBe(2);
    expect((await contentPool.query(`SELECT state FROM export.manifest WHERE id = $1`, [created.manifestId]))
      .rows[0]?.state).toBe('sealed');

    await setPrincipalActive(true);
    const recovered = await json<{ manifestDigest: string }>(
      await routeApi(exportApp, 'GET', `/v1/exports/${created.manifestId}`), 200);
    expect(recovered.manifestDigest).toBe(created.manifestDigest);
  } finally {
    pendingGate.release();
    exportGate = null;
    await setPrincipalActive(true);
  }
}, 60_000);

test('SYS06: package installation revoked during hook work stays staged until authority returns', async () => {
  await setPrincipalActive(true);
  const resolution = await json<{ resolution: { resolution: string } }>(await api('POST', '/v1/package-resolutions/npm',
    npmRegistryRequest({ name: 'sys06-install', native: false,
      manifest: { name: 'sys06-root', version: '1.0.0', dependencies: { hooked: '1.0.0' } },
      expect: { status: 'solved', correspondence: null, allowedDivergences: [] } }),
  `sys06-resolution-${randomUUID()}`), 201);
  const resolutionId = resolution.resolution.resolution.split('/').at(-1)!;
  const lock = await json<{ lock: string }>(await api('POST', '/v1/package-locks', {
    profile: 'rezics-package-lock-v1', segments: [{ ecosystem: 'npm', resolution: resolutionId,
      scope: { kind: 'process', label: 'node' } }],
  }, `sys06-lock-${randomUUID()}`), 201);
  const lockId = lock.lock.split('/').at(-1)!;
  expect((await json<{ outcome: string }>(await api('POST', `/v1/package-locks/${lockId}/replays`, undefined,
    `sys06-replay-${randomUUID()}`), 201)).outcome).toBe('verified');

  const installTarget = `sys06-${randomUUID()}`;
  const install = await json<{ installation: string }>(await api('POST', '/v1/package-installations', {
    profile: 'rezics-controlled-install-v1', target: installTarget, environment: { os: 'linux', cpu: 'x64' },
  }, `sys06-install-${randomUUID()}`), 201);
  const installationId = install.installation.split('/').at(-1)!;
  const plan = await json<{ generation: { generation: string; state: string } }>(await api('POST',
    `/v1/package-installations/${installationId}/generations`, { operation: 'install', lock: lockId,
      rollbackOf: null, expectedGeneration: null, userData: [], approveHooks: ['node_modules/hooked'] },
    `sys06-plan-${randomUUID()}`), 201);
  expect(plan.generation.state).toBe('planned');
  const targetHash = new Bun.CryptoHasher('sha256').update(installTarget).digest('hex');
  const installRoot = join(scratch, 'roots', targetHash);

  const pendingGate = gate();
  installGate = pendingGate;
  activePrincipalChecks = 0;
  const apply = api('POST', `/v1/package-installations/${installationId}/generations/${plan.generation.generation}/apply`);
  try {
    await pendingGate.entered;
    await setPrincipalActive(false);
    pendingGate.release();
    const response = await apply;
    expect(response.status, await response.clone().text()).toBe(403);
    expect(activePrincipalChecks).toBe(2);
    const saved = await contentPool.query<{ state: string; active_generation_id: string | null }>(`SELECT g.state,
      i.active_generation_id FROM pkg.installation_generation g JOIN pkg.installation i
      ON i.id = g.installation_id WHERE g.id = $1`, [plan.generation.generation]);
    expect(saved.rows).toEqual([{ state: 'staged', active_generation_id: null }]);
    await expect(readlink(join(installRoot, 'node_modules/hooked'))).rejects.toThrow();

    await setPrincipalActive(true);
    activePrincipalChecks = 0;
    const recovered = await json<{ state: string }>(await api('POST',
      `/v1/package-installations/${installationId}/generations/${plan.generation.generation}/apply`), 200);
    expect(recovered.state).toBe('active');
    expect(activePrincipalChecks).toBe(2);
    expect(await readlink(join(installRoot, 'node_modules/hooked'))).toContain(plan.generation.generation);
  } finally {
    pendingGate.release();
    installGate = null;
    await setPrincipalActive(true);
  }
}, 60_000);
