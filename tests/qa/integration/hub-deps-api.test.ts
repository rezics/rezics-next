import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { HubStore } from '../../../services/main/src/modules/hub/store.ts';
import { PackageArtifactStore } from '../../../services/main/src/modules/package/lock-artifacts.ts';
import { CargoResolutionStore } from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { PackageLockStore } from '../../../services/main/src/modules/package/lock.ts';
import { NpmResolutionStore } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { activateMetadataWork, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { cargoIndexFile } from '../fixtures/cargo-links-snapshot.ts';
import { npmRegistryRequest } from '../fixtures/npm-registry-scenarios.ts';
import { syntheticNpmFetcher } from '../fixtures/npm-registry-synthetic.ts';
import { tarGz } from './package-install-fixtures.ts';

const root = resolve(import.meta.dir, '../../..');
const issuer = 'https://qa-hub-deps.test';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let contentPool: Pool;
let accessPool: Pool;
let content: ContentCore;
let fuseki: FusekiClient;
let access: AccessAdmissionRegistry;
let environment: { fuseki: FusekiClient; lineage: { dataEpoch: string; routingEpoch: string };
  objectDirectory: string };

beforeAll(async () => {
  for (const name of ['REZICS_QA_RUN_ID', 'CONTENT_DATABASE_URL', 'ACCESS_DATABASE_URL',
    'FUSEKI_URL', 'MAIN_DATA_EPOCH', 'MAIN_ROUTING_EPOCH', 'MAIN_S3_ENDPOINT',
    'MAIN_S3_BUCKET', 'MAIN_S3_ACCESS_KEY', 'MAIN_S3_SECRET_KEY']) {
    if (!Bun.env[name]) throw new Error('Run through the isolated QA integration tier');
  }
  contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 8 });
  accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 8 });
  await migrateContent(contentPool);
  content = new ContentCore(contentPool);
  access = new AccessAdmissionRegistry(accessPool);
  fuseki = new FusekiClient(Bun.env.FUSEKI_URL!);
  environment = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!,
    routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! }, objectDirectory: join(root, '.temp', `hub-deps-${randomUUID()}`) };
});
afterAll(async () => { await Promise.all([contentPool?.end(), accessPool?.end()]); });

async function fixture(options: { interruptImport?: boolean; loseLockResponse?: boolean } = {}) {
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const admission = randomUUID();
  const title = `Hub dependencies ${admission}`;
  const created = await activateMetadataWork(environment, { title, admission: {
    id: admission, scope: 'work:create:root', action: 'work.create',
    idempotencyKey: `hub-deps-work-${admission}`,
    requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } });
  const principal = { issuer, subject: randomUUID(), id: randomUUID() };
  const other = { issuer, subject: randomUUID(), id: randomUUID() };
  await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, $2, $3), ($4, $2, $5)`, [principal.id, issuer, principal.subject, other.id, other.subject]);
  // The other caller is refused by the handler, after the closed gate.
  await grantRecordedPlatformUse(accessPool, principal.id, ['developer-extras']);
  await grantRecordedPlatformUse(accessPool, other.id, ['developer-extras']);
  await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [actor, 'agent']);
  for (const [scope, action] of [
    [`content:draft:${created.work}`, 'content.draft'], [`work:read:${created.work}`, 'work.read'],
  ]) {
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), principal.id, actor, action]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), actor, scope, action]);
  }
  const account = { verify: async (request: Request, required: readonly string[]) => {
    const [who, scope] = (request.headers.get('authorization') ?? '').replace('Bearer ', '').split(' ');
    // The exposure gate verifies with an empty scope list; a handler still rejects a mismatch.
    if (required.length > 0 && scope !== required[0]) throw new AccountAssertionDenied('wrong Hub dependency scope');
    if (who === 'owner') return { issuer, subject: principal.subject };
    if (who === 'other') return { issuer, subject: other.subject };
    throw new AccountAssertionDenied('unknown Hub dependency token');
  } };
  const namespaces = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
  await namespaces('package/artifact/public/').initialize();
  let interruptImport = options.interruptImport ?? false;
  class RecoveringArtifacts extends PackageArtifactStore {
    override async retain(bytes: Uint8Array, mediaType: string, owner: string | null) {
      if (interruptImport) {
        interruptImport = false;
        throw new Error('simulated artifact retention outage after Content commit');
      }
      return super.retain(bytes, mediaType, owner);
    }
  }
  const artifacts = new RecoveringArtifacts(contentPool, namespaces);
  const hub = new HubStore(contentPool, content, access, environment, artifacts);
  const npmSource = { shared: { versions: { '1.0.0': {} } } };
  const npmProvider = syntheticNpmFetcher(npmSource);
  const npmResolutions = new NpmResolutionStore(contentPool, { fetcher: npmProvider.fetcher });
  const cargoResolutions = new CargoResolutionStore(contentPool);
  const crate = tarGz([{ path: 'shared-1.0.0/Cargo.toml',
    content: '[package]\nname = "shared"\nversion = "1.0.0"\n' }]);
  const cargoUrl = 'https://static.crates.io/crates/shared/shared-1.0.0.crate';
  const archiveFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === cargoUrl) return new Response(crate);
    return npmProvider.fetcher(input, init);
  }) as typeof fetch;
  let loseLockResponse = options.loseLockResponse ?? false;
  class RecoveringLocks extends PackageLockStore {
    override async create(...args: Parameters<PackageLockStore['create']>) {
      const result = await super.create(...args);
      if (loseLockResponse) {
        loseLockResponse = false;
        throw new Error('simulated response loss after durable package lock commit');
      }
      return result;
    }
  }
  const locks = new RecoveringLocks(contentPool, npmResolutions, artifacts,
    { cargo: cargoResolutions, fetcher: archiveFetcher });
  const app = createMainApp(fuseki, { environment, account, access, hub, packageLocks: locks,
    packageNpmResolutions: npmResolutions, packageCargoResolutions: cargoResolutions,
    platformAccess: new AccessExposure(accessPool) });
  const call = (method: string, path: string, who: string, scope: string,
    body?: unknown, key?: string) => app.handle(new Request(`http://main.local${path}`, { method,
    headers: { authorization: `Bearer ${who} ${scope}`, 'content-type': 'application/json',
      ...key ? { 'idempotency-key': key } : {} },
    ...body === undefined ? {} : { body: JSON.stringify(body) } }));
  return { actor, created, principal, other, hub, call, crate, npmProvider };
}

function skillBody(f: Awaited<ReturnType<typeof fixture>>, name = 'multi-adapter') {
  const sidecar = { profile: 'rezics-skill-package-requirements-v1', requirements: [
    { ecosystem: 'npm', selector: '^1.0.0', target: { name: 'shared' }, strength: 'required' },
    { ecosystem: 'cargo', selector: '=1.0.0', target: { name: 'shared', table: 'dependencies' }, strength: 'required' },
  ] };
  const files = [
    { path: 'SKILL.md', executable: false, bytesBase64: Buffer.from(
      `---\nname: ${name}\ndescription: A Skill with npm and Cargo requirements\n---\nResolve by ecosystem.\n`).toString('base64') },
    { path: 'rezics.package-requirements.json', executable: false,
      bytesBase64: Buffer.from(JSON.stringify(sidecar)).toString('base64') },
  ];
  return { profile: 'agent-skills-directory-import-v1', resourceId: f.created.work,
    variantId: `urn:rezics:variant:${randomUUID()}`,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
    actingSubject: f.actor, sourceFormat: 'agent-skills-directory-v1', sourceLocator: { label: name }, files };
}

async function json(response: Response, status: number) {
  const text = await response.text();
  expect({ status: response.status, text: response.status === status ? '' : text })
    .toEqual({ status, text: '' });
  return JSON.parse(text) as Record<string, any>;
}

async function makeReceipts(f: Awaited<ReturnType<typeof fixture>>) {
  const npmRequest = npmRegistryRequest({ name: 'hub-deps-multi-adapter', native: false,
    manifest: { name: 'skill-root', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
    expect: { status: 'solved', correspondence: null, allowedDivergences: [] } });
  const npm = await json(await f.call('POST', '/v1/package-resolutions/npm', 'owner', 'package:resolve',
    npmRequest, `hub-deps-npm-${randomUUID()}`), 201);
  expect(npm.resolution.outcome.status).toBe('solved');
  const manifest = '[package]\nname = "skill-root"\nversion = "0.1.0"\nedition = "2021"\nresolver = "2"\n'
    + '[dependencies]\nshared = { version = "=1.0.0", registry = "snapshot" }\n';
  const cargoRequest = { profile: 'cargo-index-exact-resolver2-v1',
    registryIndexUrl: 'https://index.crates.io/', manifestBase64: Buffer.from(manifest).toString('base64'),
    manifestSha256: digest(Buffer.from(manifest)),
    indexFiles: [cargoIndexFile('shared', [{ name: 'shared', vers: '1.0.0', deps: [],
      cksum: digest(f.crate), features: {}, yanked: false, v: 1 }])],
    host: 'x86_64-unknown-linux-gnu', target: 'x86_64-unknown-linux-gnu', features: [], defaultFeatures: true };
  const cargo = await json(await f.call('POST', '/v1/package-resolutions/cargo', 'owner', 'package:resolve',
    cargoRequest, `hub-deps-cargo-${randomUUID()}`), 201);
  expect(cargo.resolution.outcome.status).toBe('solved');
  return { npmId: String(npm.resolution.resolution).split('/').at(-1)!,
    cargoId: String(cargo.resolution.resolution).split('/').at(-1)! };
}

function dependencyBody(actor: string, ids: { npmId: string; cargoId: string }) {
  return { profile: 'hub-dependency-lock-v1', actingSubject: actor, segments: [
    { ecosystem: 'npm', resolution: ids.npmId,
      scope: { kind: 'process', label: 'node-runtime' }, requirements: [0] },
    { ecosystem: 'cargo', resolution: ids.cargoId,
      scope: { kind: 'abi', label: 'native-build' }, requirements: [1] },
  ] };
}

async function importedSkill(f: Awaited<ReturnType<typeof fixture>>, key = `hub-deps-import-${randomUUID()}`) {
  const body = skillBody(f);
  const imported = await json(await f.call('POST', '/v1/hub/imports', 'owner', 'work:edit', body, key), 201);
  expect(imported.requirements).toEqual([
    { ordinal: 0, ecosystem: 'npm', nativeSelector: '^1.0.0', target: { name: 'shared' },
      strength: 'required', declaration: 'declared', sourcePath: 'rezics.package-requirements.json',
      sourcePointer: '/requirements/0' },
    { ordinal: 1, ecosystem: 'cargo', nativeSelector: '=1.0.0',
      target: { name: 'shared', table: 'dependencies' }, strength: 'required', declaration: 'declared',
      sourcePath: 'rezics.package-requirements.json', sourcePointer: '/requirements/1' },
  ]);
  return { imported, body, key };
}

test('HUB03/PKG18: every declared npm and Cargo requirement reaches its own scoped concrete lock artifact', async () => {
  const f = await fixture();
  const { imported, body, key: importKey } = await importedSkill(f);
  const importRetry = await json(await f.call('POST', '/v1/hub/imports', 'owner', 'work:edit', body, importKey), 200);
  expect(importRetry.requirements).toEqual(imported.requirements);
  const ids = await makeReceipts(f);
  const request = dependencyBody(f.actor, ids);
  expect((await f.call('POST', `/v1/hub/revisions/${imported.revision}/dependencies`, 'other',
    'work:read', request, `hub-deps-denied-${randomUUID()}`)).status).toBe(404);
  const crossEcosystem = structuredClone(request);
  crossEcosystem.segments[0]!.requirements = [0, 1];
  crossEcosystem.segments[1]!.requirements = [];
  expect((await f.call('POST', `/v1/hub/revisions/${imported.revision}/dependencies`, 'owner',
    'work:read', crossEcosystem, `hub-deps-cross-${randomUUID()}`)).status).toBe(422);
  const incomplete = structuredClone(request);
  incomplete.segments[0]!.requirements = [];
  incomplete.segments[1]!.requirements = [];
  expect((await f.call('POST', `/v1/hub/revisions/${imported.revision}/dependencies`, 'owner',
    'work:read', incomplete, `hub-deps-partial-${randomUUID()}`)).status).toBe(422);
  const unsupportedBody = structuredClone(body);
  unsupportedBody.variantId = `urn:rezics:variant:${randomUUID()}`;
  const sidecarFile = unsupportedBody.files.find(file => file.path === 'rezics.package-requirements.json')!;
  const sidecar = JSON.parse(Buffer.from(sidecarFile.bytesBase64, 'base64').toString()) as {
    profile: string; requirements: Array<Record<string, unknown>> };
  sidecar.requirements.push({ ecosystem: 'pypi', selector: '>=1', target: { name: 'sample' },
    strength: 'required' });
  sidecarFile.bytesBase64 = Buffer.from(JSON.stringify(sidecar)).toString('base64');
  const unsupported = await json(await f.call('POST', '/v1/hub/imports', 'owner', 'work:edit',
    unsupportedBody, `hub-deps-unsupported-${randomUUID()}`), 201);
  expect(unsupported.requirements[2]).toMatchObject({ ecosystem: 'pypi', declaration: 'unsupported' });
  expect((await f.call('POST', `/v1/hub/revisions/${unsupported.revision}/dependencies`, 'owner',
    'work:read', request, `hub-deps-unsupported-lock-${randomUUID()}`)).status).toBe(422);
  expect((await contentPool.query(`SELECT count(*)::int AS n FROM pkg.lock
    WHERE subject_revision_id = $1`, [imported.revision])).rows[0]!.n).toBe(0);

  const key = `hub-deps-valid-${randomUUID()}`;
  const lock = await json(await f.call('POST', `/v1/hub/revisions/${imported.revision}/dependencies`, 'owner',
    'work:read', request, key), 201);
  expect(lock.manifest.subject).toMatchObject({ revision: imported.revision,
    requirementMappings: [{ requirementOrdinal: 0, segmentOrdinal: 0 },
      { requirementOrdinal: 1, segmentOrdinal: 1 }] });
  expect(lock.manifest.subject.requirements).toEqual(imported.requirements);
  expect(lock.manifest.segments.map((segment: any) => [segment.ecosystem, segment.scope]))
    .toEqual([['npm', { kind: 'process', label: 'node-runtime' }],
      ['cargo', { kind: 'abi', label: 'native-build' }]]);
  expect(lock.manifest.artifacts.map((artifact: any) => [artifact.segment, artifact.ecosystem]))
    .toEqual([[0, 'npm'], [1, 'cargo']]);
  expect(lock.manifest.artifacts.map((artifact: any) => [artifact.coordinate.name,
    artifact.coordinate.version])).toEqual([['shared', '1.0.0'], ['shared', '1.0.0']]);
  expect(lock.manifest.artifacts.every((artifact: any) => artifact.integrity.value)).toBe(true);
  expect((await contentPool.query(`SELECT requirement_ordinal, ecosystem, segment_ordinal
    FROM pkg.lock_requirement WHERE lock_id = $1 ORDER BY requirement_ordinal`, [lock.lock])).rows)
    .toEqual([{ requirement_ordinal: 0, ecosystem: 'npm', segment_ordinal: 0 },
      { requirement_ordinal: 1, ecosystem: 'cargo', segment_ordinal: 1 }]);
  expect((await f.call('GET', `/v1/package-locks/${lock.lock}`, 'other', 'package:read')).status).toBe(404);
  const exactLock = await json(await f.call('GET', `/v1/package-locks/${lock.lock}`, 'owner',
    'package:read'), 200);
  expect(exactLock.manifest).toEqual(lock.manifest);
  const firstReplay = await json(await f.call('POST', `/v1/package-locks/${lock.lock}/replays`,
    'owner', 'package:verify', undefined, `hub-deps-replay-${randomUUID()}`), 201);
  expect(firstReplay).toMatchObject({ outcome: 'verified', artifacts: [
    expect.objectContaining({ result: 'verified', locator: 'https://registry.npmjs.org/shared/-/shared-1.0.0.tgz' }),
    expect.objectContaining({ result: 'verified', locator: 'https://static.crates.io/crates/shared/shared-1.0.0.crate' }),
  ] });
});

test('HUB03: denied, stale-key and concurrent dependency writes have exact outcomes', async () => {
  const f = await fixture();
  const { imported } = await importedSkill(f);
  const ids = await makeReceipts(f);
  const request = dependencyBody(f.actor, ids);
  const key = `hub-deps-race-${randomUUID()}`;
  const raced = await Promise.all([f.call('POST', `/v1/hub/revisions/${imported.revision}/dependencies`,
    'owner', 'work:read', request, key), f.call('POST',
    `/v1/hub/revisions/${imported.revision}/dependencies`, 'owner', 'work:read', request, key)]);
  expect(raced.map(response => response.status).sort()).toEqual([200, 201]);
  const values = await Promise.all(raced.map(response => response.json() as Promise<Record<string, any>>));
  expect(values[0]!.lock).toBe(values[1]!.lock);
  expect((await contentPool.query(`SELECT count(*)::int AS n FROM pkg.lock
    WHERE principal_id = $1 AND idempotency_key = $2`, [f.principal.id, key])).rows[0]!.n).toBe(1);
  const changed = structuredClone(request);
  changed.segments[0]!.scope.label = 'stale-intent';
  expect((await f.call('POST', `/v1/hub/revisions/${imported.revision}/dependencies`, 'owner',
    'work:read', changed, key)).status).toBe(409);
  expect((await f.call('POST', `/v1/hub/revisions/${imported.revision}/dependencies`, 'other',
    'work:read', request, `hub-deps-other-${randomUUID()}`)).status).toBe(404);
});

test('HUB03/PKG18: interrupted import and lost lock response recover to exact requirements, read and replay', async () => {
  const f = await fixture({ interruptImport: true, loseLockResponse: true });
  const body = skillBody(f, 'recover-adapters');
  const importKey = `hub-deps-import-recovery-${randomUUID()}`;
  expect((await f.call('POST', '/v1/hub/imports', 'owner', 'work:edit', body, importKey)).status)
    .toBeGreaterThanOrEqual(500);
  const imported = await json(await f.call('POST', '/v1/hub/imports', 'owner', 'work:edit', body, importKey), 200);
  expect(imported.requirements).toHaveLength(2);
  const rows = await contentPool.query(`SELECT requirement_count FROM hub.revision WHERE revision_id = $1`,
    [imported.revision]);
  expect(rows.rows[0]!.requirement_count).toBe(2);
  const ids = await makeReceipts(f);
  const request = dependencyBody(f.actor, ids);
  const key = `hub-deps-lock-recovery-${randomUUID()}`;
  expect((await f.call('POST', `/v1/hub/revisions/${imported.revision}/dependencies`, 'owner',
    'work:read', request, key)).status).toBeGreaterThanOrEqual(500);
  const recovered = await json(await f.call('POST',
    `/v1/hub/revisions/${imported.revision}/dependencies`, 'owner', 'work:read', request, key), 200);
  expect(recovered.manifest.subject).toMatchObject({ revision: imported.revision,
    requirementMappings: [{ requirementOrdinal: 0, segmentOrdinal: 0 },
      { requirementOrdinal: 1, segmentOrdinal: 1 }] });
  expect((await json(await f.call('GET', `/v1/package-locks/${recovered.lock}`, 'owner', 'package:read'), 200))
    .manifest).toEqual(recovered.manifest);
  expect((await json(await f.call('POST', `/v1/package-locks/${recovered.lock}/replays`, 'owner',
    'package:verify', undefined, `hub-deps-recovery-replay-${randomUUID()}`), 201)).outcome).toBe('verified');
});
