import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied, AccountAssertionVerifier }
  from '../../../services/main/src/modules/account/verify-assertion.ts';
import { PackageInstallationStore, PackageInstallDenied, type HookExecutor, type InstallFault }
  from '../../../services/main/src/modules/package/install.ts';
import { DockerNodeHookExecutor, NODE_HOOK_PROFILE, validateHookOutput }
  from '../../../services/main/src/modules/package/install-hooks.ts';
import { PackageArtifactStore } from '../../../services/main/src/modules/package/lock-artifacts.ts';
import { PackageLockStore, strongestIntegrity } from '../../../services/main/src/modules/package/lock.ts';
import { NpmResolutionStore } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { npmRegistryRequest } from '../fixtures/npm-registry-scenarios.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { qaEnvironment, startAccount } from './account-boundary-fixture.ts';
import { archiveNpmFetcher, packageFiles, type ArchiveRegistry } from './package-install-fixtures.ts';

const root = resolve(import.meta.dir, '../../..');
const issuer = 'https://qa-package-install.test';
let contentPool: Pool;
let accessPool: Pool;
let rootDirectory: string;
let namespaces: (prefix: string) => S3ImmutableObjects;

beforeAll(async () => {
  for (const name of ['REZICS_QA_RUN_ID', 'CONTENT_DATABASE_URL', 'ACCESS_DATABASE_URL', 'FUSEKI_URL',
    'MAIN_S3_ENDPOINT', 'MAIN_S3_BUCKET', 'MAIN_S3_ACCESS_KEY', 'MAIN_S3_SECRET_KEY']) {
    if (!Bun.env[name]) throw new Error('Run through the isolated QA integration tier');
  }
  contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 8 });
  accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 4 });
  await migrateContent(contentPool);
  rootDirectory = join(root, '.temp', `package-install-${randomUUID()}`);
  await mkdir(rootDirectory, { recursive: true });
  namespaces = prefix => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
  await namespaces('package/artifact/public/').initialize();
});

afterAll(async () => { await Promise.all([contentPool?.end(), accessPool?.end()]); });

interface Fixture {
  call: (method: string, path: string, token: string, body?: unknown, key?: string) => Promise<Response>;
  withAccount: (verifier: AccountAssertionVerifier) => Fixture['call'];
  registry: ArchiveRegistry;
  provider: ReturnType<typeof archiveNpmFetcher>;
  owner: { id: string; subject: string };
  store: (fault?: InstallFault, executor?: HookExecutor) => PackageInstallationStore;
  hookRuns: string[];
  rootOf: (target: string) => string;
}

async function fixture(packages: ArchiveRegistry['packages']): Promise<Fixture> {
  const registry: ArchiveRegistry = { packages, tamper: new Set(), missing: new Set() };
  const provider = archiveNpmFetcher(registry);
  const owner = { id: randomUUID(), subject: randomUUID() };
  const other = { id: randomUUID(), subject: randomUUID() };
  await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, $2, $3), ($4, $2, $5)`, [owner.id, issuer, owner.subject, other.id, other.subject]);
  const hookRuns: string[] = [];
  const hookExecutor: HookExecutor = { profile: 'qa-sandbox-hook-runner-v1', run: async input => {
    hookRuns.push(`${input.instanceKey}:${input.hooks.join(',')}`);
    await writeFile(join(input.directory, 'built.txt'), input.hooks.join(','));
  } };
  const npm = new NpmResolutionStore(contentPool, { fetcher: provider.fetcher });
  const locks = new PackageLockStore(contentPool, npm, new PackageArtifactStore(contentPool, namespaces),
    { fetcher: provider.fetcher });
  const store = (fault?: InstallFault, executor: HookExecutor = hookExecutor) =>
    new PackageInstallationStore(contentPool, locks, { rootDirectory, hookExecutor: executor, fault });
  let installations = store();
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL!);
  const fakeAccount = { verify: async (request: Request, required: readonly string[]) => {
    const [who, scope] = (request.headers.get('authorization') ?? '').replace('Bearer ', '').split(' ');
    if (scope && scope !== required[0]) throw new AccountAssertionDenied('package scope is unavailable');
    if (who === 'owner') return { issuer, subject: owner.subject };
    if (who === 'other') return { issuer, subject: other.subject };
    throw new AccountAssertionDenied('unknown test token');
  } };
  const app = (account: typeof fakeAccount | AccountAssertionVerifier = fakeAccount) => createMainApp(fuseki, {
    environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
      objectDirectory: '.temp/package-install-unused' },
    account,
    access: new AccessAdmissionRegistry(accessPool),
    packageNpmResolutions: npm, packageLocks: locks, packageInstallations: installations,
  });
  const call = (method: string, path: string, token: string, body?: unknown, key?: string,
    verifier?: AccountAssertionVerifier) => app(verifier).handle(new Request(`http://main.local${path}`, { method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      ...key ? { 'idempotency-key': key } : {} }, ...body === undefined ? {} : { body: JSON.stringify(body) } }));
  return {
    registry, provider, owner, hookRuns,
    rootOf: target => join(rootDirectory, 'roots', new Bun.CryptoHasher('sha256').update(target).digest('hex')),
    store: (fault, executor) => { installations = store(fault, executor); return installations; },
    call,
    withAccount: verifier => (method, path, token, body, key) =>
      call(method, path, token, body, key, verifier),
  };
}

const json = async <T = Record<string, any>>(response: Response, status: number): Promise<T> => {
  const text = await response.text();
  expect({ status: response.status, text: response.status === status ? '' : text }).toEqual({ status, text: '' });
  return JSON.parse(text) as T;
};

async function resolveLock(f: Fixture, dependencies: Record<string, string>): Promise<{ lock: string;
  resolution: string; body: any }> {
  const resolution = await json(await f.call('POST', '/v1/package-resolutions/npm', 'owner',
    npmRegistryRequest({ name: 'install', native: false, manifest: { name: 'install-root', version: '1.0.0', dependencies },
      expect: { status: 'solved', correspondence: null, allowedDivergences: [] } }), `npm-${randomUUID()}`), 201);
  const id = resolution.resolution.resolution.split('/').at(-1)!;
  const body = { profile: 'rezics-package-lock-v1', segments: [{ ecosystem: 'npm', resolution: id,
    scope: { kind: 'process', label: 'node' } }] };
  const lock = await json(await f.call('POST', '/v1/package-locks', 'owner', body, `lock-${randomUUID()}`), 201);
  return { lock: lock.lock, resolution: id, body };
}

async function verifiedReplay(f: Fixture, lock: string): Promise<Record<string, any>> {
  const replay = await json(await f.call('POST', `/v1/package-locks/${lock}/replays`, 'owner', undefined,
    `replay-${randomUUID()}`), 201);
  expect(replay.outcome).toBe('verified');
  return replay;
}

async function installation(f: Fixture, target: string): Promise<string> {
  return (await json(await f.call('POST', '/v1/package-installations', 'owner', {
    profile: 'rezics-controlled-install-v1', target, environment: { os: 'linux', cpu: 'x64' } },
  `installation-${randomUUID()}`), 201)).installation;
}

const plan = (f: Fixture, id: string, body: Record<string, unknown>, key = `plan-${randomUUID()}`) =>
  f.call('POST', `/v1/package-installations/${id}/generations`, 'owner', { lock: null, rollbackOf: null,
    expectedGeneration: null, userData: [], approveHooks: [], ...body }, key);
const apply = (f: Fixture, id: string, generation: string) =>
  f.call('POST', `/v1/package-installations/${id}/generations/${generation}/apply`, 'owner');

test('PKG14: malformed or truncated SRI cannot become a lock digest', () => {
  expect(strongestIntegrity('sha512-eA==')).toBeNull();
  expect(strongestIntegrity('sha512-%%%')).toBeNull();
  expect(strongestIntegrity(`sha512-${Buffer.alloc(64).toString('base64')}`)).not.toBeNull();
});

async function mountTarget(f: Fixture, target: string, path: string): Promise<string | null> {
  const link = join(f.rootOf(target), path);
  const stat = await lstat(link).catch(() => null);
  return stat?.isSymbolicLink() ? readlink(link) : null;
}

test('PKG14: lock replay re-verifies exact artifacts after mutable tag and file changes, or reports them unavailable', async () => {
  const f = await fixture({ a: { tags: { latest: '1.0.0' }, versions: { '1.0.0': {}, '1.1.0': {} } },
    b: { versions: { '1.0.0': {} } } });
  const { lock, resolution, body } = await resolveLock(f, { a: 'latest', b: '^1.0.0' });
  const created = await json(await f.call('GET', `/v1/package-locks/${lock}`, 'owner'), 200);
  expect(created.manifest.artifacts.map((item: any) => [item.instanceKey, item.mutableReference,
    item.integrity.algorithm])).toEqual([['node_modules/a', 'dist-tag:latest', 'sha512'],
    ['node_modules/b', null, 'sha512']]);
  expect(created.manifest.segments[0]).toMatchObject({ resolution, scope: { kind: 'process', label: 'node' } });
  // Idempotency, changed intent, private reads, scope and key checks.
  const key = `lock-${randomUUID()}`;
  const first = await json(await f.call('POST', '/v1/package-locks', 'owner', body, key), 201);
  expect(await json(await f.call('POST', '/v1/package-locks', 'owner', body, key), 200)).toEqual(first);
  expect((await f.call('POST', '/v1/package-locks', 'owner', { ...body, segments: [{ ...body.segments[0],
    scope: { kind: 'path', label: 'other' } }] }, key)).status).toBe(409);
  expect((await f.call('POST', '/v1/package-locks', 'owner', body)).status).toBe(400);
  expect((await f.call('POST', '/v1/package-locks', 'owner package:read', body, `lock-${randomUUID()}`)).status).toBe(401);
  expect((await f.call('POST', '/v1/package-locks', 'other', body, `lock-${randomUUID()}`)).status).toBe(404);
  expect((await f.call('GET', `/v1/package-locks/${lock}`, 'other')).status).toBe(404);

  const replayKey = `replay-${randomUUID()}`;
  const tarballs = () => f.provider.requests.filter(url => url.endsWith('.tgz')).length;
  const before = tarballs();
  const verified = await json(await f.call('POST', `/v1/package-locks/${lock}/replays`, 'owner', undefined, replayKey), 201);
  expect(verified).toMatchObject({ lock, outcome: 'verified', lockSha256: created.lockSha256 });
  expect(verified.artifacts.map((item: any) => item.result)).toEqual(['verified', 'verified']);
  expect(tarballs() - before).toBe(2);
  expect(await json(await f.call('POST', `/v1/package-locks/${lock}/replays`, 'owner', undefined, replayKey), 200))
    .toEqual(verified);
  expect(tarballs() - before).toBe(2);
  expect(await json(await f.call('GET', `/v1/package-lock-replays/${verified.replay}`, 'owner'), 200)).toEqual(verified);
  expect((await f.call('GET', `/v1/package-lock-replays/${verified.replay}`, 'other')).status).toBe(404);
  const stored = (await contentPool.query(`SELECT a.object_key, a.state FROM pkg.artifact a
    WHERE a.id = $1`, [verified.artifacts[0].artifact])).rows[0];
  expect(stored).toEqual({ state: 'verified', object_key: expect.stringMatching(/^package\/artifact\/public\/sha256\//) });

  // The mutable tag moves: the lock still verifies the exact locked tarball, reading no packument.
  f.registry.packages.a!.tags = { latest: '1.1.0' };
  const packuments = f.provider.requests.filter(url => !url.endsWith('.tgz')).length;
  const moved = await json(await f.call('POST', `/v1/package-locks/${lock}/replays`, 'owner', undefined,
    `replay-${randomUUID()}`), 201);
  expect(moved.outcome).toBe('verified');
  expect(f.provider.requests.filter(url => !url.endsWith('.tgz')).length).toBe(packuments);
  // The file behind the same locator changes: exact validation fails and the replay is unavailable.
  f.registry.tamper.add(f.provider.tarball('a', '1.0.0'));
  f.registry.missing.add(f.provider.tarball('b', '1.0.0'));
  const changed = await json(await f.call('POST', `/v1/package-locks/${lock}/replays`, 'owner', undefined,
    `replay-${randomUUID()}`), 201);
  expect(changed.outcome).toBe('unavailable');
  expect(changed.artifacts.map((item: any) => [item.result, item.mutableReference])).toEqual([
    ['digest-mismatch', 'dist-tag:latest'], ['unavailable', null]]);
  expect(changed.artifacts[0].observedSha256).not.toBe(stored.object_key.split('/').at(-1));
  // The lock itself never changes; an update needs a new resolution and lock.
  expect(await json(await f.call('GET', `/v1/package-locks/${lock}`, 'owner'), 200)).toEqual(created);
  await expect(contentPool.query(`UPDATE pkg.lock SET manifest = '{}' WHERE id = $1`, [lock])).rejects.toThrow();
});

test('PKG15: staging rejects archive traversal, ownership collisions and unapproved hooks before any effect', async () => {
  const f = await fixture({
    evil: { versions: { '1.0.0': { entries: packageFiles('evil', '1.0.0', [
      { path: 'package/../../escape.txt', content: 'escaped' },
      { path: 'package/lib', type: '2', link: '../../../etc' }]) } } },
    folded: { versions: { '1.0.0': { entries: packageFiles('folded', '1.0.0', [
      { path: 'package/README', content: 'one' }, { path: 'package/readme', content: 'two' }]) } } },
    hooked: { versions: { '1.0.0': { scripts: { postinstall: 'node steal-secrets.js' }, installScript: true } } },
    good: { versions: { '1.0.0': {} } },
  });
  const target = `qa-root-${randomUUID()}`;
  const expectUntouched = async () => {
    const entries = await readdir(f.rootOf(target)).catch(() => []);
    expect(entries.filter(name => name !== '.rezics')).toEqual([]);
    expect(await readdir(join(rootDirectory, '..')).then(names => names.includes('escape.txt'))).toBe(false);
  };

  const evil = await resolveLock(f, { evil: '1.0.0' });
  await verifiedReplay(f, evil.lock);
  const first = await installation(f, target);
  const traversal = await json(await plan(f, first, { operation: 'install', lock: evil.lock }), 201);
  expect(traversal.generation).toMatchObject({ state: 'rejected', terminalReason: 'path-traversal', paths: [] });
  expect(traversal.violations.map((item: any) => [item.kind, item.path])).toEqual([
    ['path-traversal', 'package/../../escape.txt'], ['link-escape', 'lib']]);
  expect((await apply(f, first, traversal.generation.generation)).status).toBe(409);
  await expectUntouched();

  const folded = await resolveLock(f, { folded: '1.0.0' });
  await verifiedReplay(f, folded.lock);
  const collision = await json(await plan(f, first, { operation: 'install', lock: folded.lock }), 201);
  expect(collision.generation).toMatchObject({ state: 'rejected', terminalReason: 'ownership-collision' });
  expect(collision.violations).toEqual([expect.objectContaining({ kind: 'case-collision', path: 'readme' })]);

  const hooked = await resolveLock(f, { hooked: '1.0.0', good: '1.0.0' });
  await verifiedReplay(f, hooked.lock);
  const unapproved = await json(await plan(f, first, { operation: 'install', lock: hooked.lock }), 201);
  expect(unapproved.generation).toMatchObject({ state: 'rejected', terminalReason: 'unapproved-hook' });
  expect(unapproved.generation.steps.filter((step: any) => step.executesCode)).toEqual([expect.objectContaining({
    action: 'build', instanceKey: 'node_modules/hooked', approved: false, lastEvent: null })]);
  expect(unapproved.violations).toEqual([expect.objectContaining({ reason: 'unapproved-hook',
    instanceKey: 'node_modules/hooked', detail: 'postinstall' })]);
  expect((await apply(f, first, unapproved.generation.generation)).status).toBe(409);
  expect(f.hookRuns).toEqual([]);
  await expectUntouched();
  // DB guard: even a direct transition cannot leave planned with an unapproved hook.
  expect((await contentPool.query(`SELECT count(*)::int AS n FROM pkg.installation_journal
    WHERE generation_id = ANY($1::uuid[])`, [[traversal.generation.generation, unapproved.generation.generation]]))
    .rows[0].n).toBe(0);

  // Unrelated rejected history does not make the installation summary unbounded.
  for (let index = 0; index < 63; index++) {
    const historical = await json(await plan(f, first, { operation: 'install', lock: hooked.lock }), 201);
    expect(historical.generation.state).toBe('rejected');
  }
  const bounded = await json(await f.call('GET', `/v1/package-installations/${first}`, 'owner'), 200);
  expect(bounded.generations).toHaveLength(64);
  expect(bounded.generationsTruncated).toBe(true);
  expect((await json(await f.call('GET', `/v1/package-installations/${first}/generations/${traversal.generation.generation}`,
    'owner'), 200)).state).toBe('rejected');

  // The approved hook runs once through the configured executor.
  const approved = await json(await plan(f, first, { operation: 'install', lock: hooked.lock,
    approveHooks: ['node_modules/hooked'] }), 201);
  expect(approved.generation.state).toBe('planned');
  expect((await json(await apply(f, first, approved.generation.generation), 200)).state).toBe('active');
  expect(f.hookRuns).toEqual(['node_modules/hooked:postinstall']);
  expect(await readFile(join(f.rootOf(target), 'node_modules/hooked/built.txt'), 'utf8')).toBe('postinstall');

  // A second installation in the same root cannot take owned paths, including case-folded ones.
  const good = await resolveLock(f, { good: '1.0.0' });
  await verifiedReplay(f, good.lock);
  const second = await installation(f, target);
  const taken = await json(await plan(f, second, { operation: 'install', lock: good.lock,
    userData: [{ path: 'Node_Modules/Hooked/cache', kind: 'directory' }] }), 201);
  expect(taken.generation).toMatchObject({ state: 'rejected', terminalReason: 'ownership-collision' });
  expect(taken.violations.map((item: any) => item.path).sort()).toEqual(['node_modules/good', 'node_modules/hooked']);
  expect(await mountTarget(f, target, 'node_modules/good')).toContain(approved.generation.generation);
  expect((await json(await f.call('GET', `/v1/package-installations/${second}`, 'owner'), 200)).claims).toEqual([]);

  // An existing symlink above a mount cannot redirect extraction or activation outside this root.
  const divertedTarget = `qa-root-${randomUUID()}`;
  const diverted = await installation(f, divertedTarget);
  const outside = join(rootDirectory, `outside-${randomUUID()}`);
  await mkdir(outside, { recursive: true });
  await mkdir(f.rootOf(divertedTarget), { recursive: true });
  await symlink(outside, join(f.rootOf(divertedTarget), 'node_modules'));
  const redirected = await json(await plan(f, diverted, { operation: 'install', lock: good.lock }), 201);
  expect(redirected.generation).toMatchObject({ state: 'rejected', terminalReason: 'ownership-collision' });
  expect(redirected.violations).toEqual([expect.objectContaining({ path: 'node_modules/good',
    detail: 'a mount path or parent is not owned by this installation' })]);
  expect(await readdir(outside)).toEqual([]);

  const hijackedTarget = `qa-root-${randomUUID()}`;
  const hijacked = await installation(f, hijackedTarget);
  await mkdir(join(f.rootOf(hijackedTarget), 'node_modules'), { recursive: true });
  await symlink(outside, join(f.rootOf(hijackedTarget), 'node_modules/good'));
  const hijackedPlan = await json(await plan(f, hijacked, { operation: 'install', lock: good.lock }), 201);
  expect(hijackedPlan.generation).toMatchObject({ state: 'rejected', terminalReason: 'ownership-collision' });
  expect(await readdir(outside)).toEqual([]);
}, 20_000);

test('PKG16: interrupted activation, update and removal recover from the journal and preserve user data', async () => {
  const f = await fixture({ x: { versions: { '1.0.0': {}, '2.0.0': {} } }, y: { versions: { '1.0.0': {} } },
    z: { versions: { '1.0.0': {} } },
    h: { versions: { '1.0.0': { scripts: { install: 'node build.js' }, installScript: true } } } });
  const target = `qa-root-${randomUUID()}`;
  const id = await installation(f, target);
  const v1 = await resolveLock(f, { x: '1.0.0', y: '1.0.0' });
  await verifiedReplay(f, v1.lock);
  const userData = [{ path: 'config/settings.json', kind: 'file' }];
  const g1 = (await json(await plan(f, id, { operation: 'install', lock: v1.lock, userData }), 201)).generation;
  f.store('mid-switch');
  expect((await apply(f, id, g1.generation)).status).toBe(503);
  let view = await json(await f.call('GET', `/v1/package-installations/${id}/generations/${g1.generation}`, 'owner'), 200);
  expect(view.state).toBe('activating');
  expect(view.steps.find((step: any) => step.action === 'switch').lastEvent).toBe('intent');
  expect((await json(await f.call('GET', `/v1/package-installations/${id}`, 'owner'), 200)).activeGeneration).toBeNull();
  f.store();
  expect((await json(await apply(f, id, g1.generation), 200)).state).toBe('active');
  for (const mount of ['node_modules/x', 'node_modules/y']) {
    expect(await mountTarget(f, target, mount)).toContain(g1.generation);
  }
  await mkdir(join(f.rootOf(target), 'config'), { recursive: true });
  await writeFile(join(f.rootOf(target), 'config/settings.json'), '{"theme":"user"}');

  // Stale and concurrent plans are refused.
  const v2 = await resolveLock(f, { x: '2.0.0', y: '1.0.0' });
  await verifiedReplay(f, v2.lock);
  expect((await plan(f, id, { operation: 'update', lock: v2.lock, expectedGeneration: randomUUID() })).status).toBe(409);
  const g2 = (await json(await plan(f, id, { operation: 'update', lock: v2.lock, expectedGeneration: g1.generation,
    userData }), 201)).generation;
  expect((await plan(f, id, { operation: 'update', lock: v2.lock, expectedGeneration: g1.generation })).status).toBe(409);
  // Generation switched and committed, response lost: a retry reconciles and reports the committed state.
  f.store('after-activation-commit');
  expect((await apply(f, id, g2.generation)).status).toBe(503);
  expect((await json(await f.call('GET', `/v1/package-installations/${id}`, 'owner'), 200)).activeGeneration)
    .toBe(g2.generation);
  f.store();
  expect((await json(await apply(f, id, g2.generation), 200)).state).toBe('active');
  expect(await readFile(join(f.rootOf(target), 'node_modules/x/index.js'), 'utf8')).toContain('x@2.0.0');

  // Partial unpack is recreated from owned staging.
  const v3 = await resolveLock(f, { x: '2.0.0', z: '1.0.0' });
  await verifiedReplay(f, v3.lock);
  const g3 = (await json(await plan(f, id, { operation: 'update', lock: v3.lock, expectedGeneration: g2.generation,
    userData }), 201)).generation;
  f.store('after-unpack-intent');
  expect((await apply(f, id, g3.generation)).status).toBe(503);
  f.store();
  expect((await json(await apply(f, id, g3.generation), 200)).state).toBe('active');
  expect(await mountTarget(f, target, 'node_modules/y')).toBeNull();
  expect(await mountTarget(f, target, 'node_modules/z')).toContain(g3.generation);

  // An unknown hook outcome is inspected, never repeated; the active generation stays.
  const hooked = await resolveLock(f, { x: '2.0.0', z: '1.0.0', h: '1.0.0' });
  await verifiedReplay(f, hooked.lock);
  const g4 = (await json(await plan(f, id, { operation: 'update', lock: hooked.lock, expectedGeneration: g3.generation,
    userData, approveHooks: ['node_modules/h'] }), 201)).generation;
  f.store('after-hook-intent');
  expect((await apply(f, id, g4.generation)).status).toBe(503);
  f.store();
  expect(await json(await apply(f, id, g4.generation), 200)).toMatchObject({ state: 'failed', terminalReason: 'step-failed' });
  expect(f.hookRuns).toEqual([]);
  const events = (await contentPool.query(`SELECT j.event, j.effect FROM pkg.installation_journal j
    JOIN pkg.installation_step s ON s.generation_id = j.generation_id AND s.ordinal = j.step_ordinal
    WHERE j.generation_id = $1 AND s.action = 'build' ORDER BY j.sequence`, [g4.generation])).rows;
  expect(events).toEqual([{ event: 'intent', effect: 'none' }, { event: 'reconciled', effect: 'unknown' }]);
  expect((await json(await f.call('GET', `/v1/package-installations/${id}`, 'owner'), 200)).activeGeneration)
    .toBe(g3.generation);

  // Interrupted removal removes the remaining owned paths only and keeps declared user data.
  const g5 = (await json(await plan(f, id, { operation: 'remove', expectedGeneration: g3.generation }), 201)).generation;
  f.store('mid-remove');
  expect((await apply(f, id, g5.generation)).status).toBe(503);
  f.store();
  expect((await json(await apply(f, id, g5.generation), 200)).state).toBe('active');
  const removed = await json(await f.call('GET', `/v1/package-installations/${id}`, 'owner'), 200);
  expect(removed).toMatchObject({ state: 'removed', activeGeneration: g5.generation,
    claims: [{ path: 'config/settings.json', ownership: 'user-data' }] });
  expect(await mountTarget(f, target, 'node_modules/x')).toBeNull();
  expect(await mountTarget(f, target, 'node_modules/z')).toBeNull();
  expect(await readFile(join(f.rootOf(target), 'config/settings.json'), 'utf8')).toBe('{"theme":"user"}');
  expect(await readdir(join(f.rootOf(target), '.rezics', 'generations'))).toEqual([]);
  expect((await plan(f, id, { operation: 'install', lock: v1.lock })).status).toBe(409);
});

test('PKG15: approved hook runs in the pinned production container through Main API', async () => {
  const script = `node -e "const fs=require('node:fs');if(process.env.CONTENT_DATABASE_URL)`
    + `throw Error('host secret leaked');try{fs.writeFileSync('/root/probe','x');`
    + `throw Error('writable root')}catch(e){if(e.message==='writable root')throw e}`
    + `if(Object.keys(require('node:os').networkInterfaces()).some(n=>n!=='lo'))`
    + `throw Error('network available');`
    + `fs.writeFileSync('built.txt','isolated')"`;
  const f = await fixture({ hooked: { versions: { '1.0.0': { scripts: { postinstall: script },
    installScript: true } } } });
  f.store(undefined, new DockerNodeHookExecutor(rootDirectory));
  const lock = await resolveLock(f, { hooked: '1.0.0' });
  await verifiedReplay(f, lock.lock);
  const target = `qa-hook-${randomUUID()}`;
  const id = await installation(f, target);
  const denied = await json(await plan(f, id, { operation: 'install', lock: lock.lock }), 201);
  expect(denied.generation).toMatchObject({ state: 'rejected', terminalReason: 'unapproved-hook' });
  const approved = await json(await plan(f, id, { operation: 'install', lock: lock.lock,
    approveHooks: ['node_modules/hooked'] }), 201);
  expect(approved.generation.steps.find((step: any) => step.action === 'build'))
    .toMatchObject({ approved: true, executesCode: true });
  const profile = (await contentPool.query<{ executor_profile: string }>(`SELECT executor_profile
    FROM pkg.installation_step WHERE generation_id = $1 AND action = 'build'`,
  [approved.generation.generation])).rows[0]?.executor_profile;
  expect(profile).toBe(NODE_HOOK_PROFILE);
  expect((await json(await apply(f, id, approved.generation.generation), 200)).state).toBe('active');
  expect(await readFile(join(f.rootOf(target), 'node_modules/hooked/built.txt'), 'utf8')).toBe('isolated');
});

test('PKG15: unsafe hook output is rejected and leaves no package mount', async () => {
  const unsafe = await fixture({ bad: { versions: { '1.0.0': {
    scripts: { postinstall: `node -e "require('node:fs').symlinkSync('/etc/passwd','host-file')"` },
    installScript: true } } } });
  unsafe.store(undefined, { profile: NODE_HOOK_PROFILE, run: async input => {
    await symlink('/etc/passwd', join(input.directory, 'host-file'));
    await validateHookOutput(input.directory);
  } });
  const badLock = await resolveLock(unsafe, { bad: '1.0.0' });
  await verifiedReplay(unsafe, badLock.lock);
  const badTarget = `qa-unsafe-hook-${randomUUID()}`;
  const badId = await installation(unsafe, badTarget);
  const bad = await json(await plan(unsafe, badId, { operation: 'install', lock: badLock.lock,
    approveHooks: ['node_modules/bad'] }), 201);
  expect(await json(await apply(unsafe, badId, bad.generation.generation), 200))
    .toMatchObject({ state: 'failed', terminalReason: 'step-failed' });
  expect(await readdir(unsafe.rootOf(badTarget)).then(names => names.includes('node_modules'))).toBe(false);
});

test('PKG17: rollback after artifact or authority revocation enforces current policy without resurrection', async () => {
  const f = await fixture({ p: { versions: { '1.0.0': {}, '2.0.0': {} } } });
  const target = `qa-root-${randomUUID()}`;
  const id = await installation(f, target);
  const l1 = await resolveLock(f, { p: '1.0.0' });
  const r1 = await verifiedReplay(f, l1.lock);
  const l2 = await resolveLock(f, { p: '2.0.0' });
  await verifiedReplay(f, l2.lock);
  const activate = async (body: Record<string, unknown>) => {
    const generation = (await json(await plan(f, id, body), 201)).generation;
    return json(await apply(f, id, generation.generation), 200);
  };
  const g1 = await activate({ operation: 'install', lock: l1.lock });
  const g2 = await activate({ operation: 'update', lock: l2.lock, expectedGeneration: g1.generation });
  // An eligible rollback restores the earlier exact artifacts from retained bytes.
  const g3 = await activate({ operation: 'rollback', rollbackOf: g1.generation, expectedGeneration: g2.generation });
  expect(g3).toMatchObject({ state: 'active', operation: 'rollback', lock: l1.lock });
  expect(await readFile(join(f.rootOf(target), 'node_modules/p/index.js'), 'utf8')).toContain('p@1.0.0');
  const g4 = await activate({ operation: 'update', lock: l2.lock, expectedGeneration: g3.generation });

  // Artifact revocation: the rollback plan is rejected and nothing is resurrected.
  const digest = (await contentPool.query('SELECT sha256 FROM pkg.artifact WHERE id = $1',
    [r1.artifacts[0].artifact])).rows[0].sha256;
  expect((await f.call('POST', '/v1/package-artifacts/revocations', 'owner package:read', { sha256: digest,
    reason: 'malicious', basis: { advisory: 'QA-1' } }, `revoke-${randomUUID()}`)).status).toBe(401);
  const revocationKey = `revoke-${randomUUID()}`;
  const revoked = await json(await f.call('POST', '/v1/package-artifacts/revocations', 'owner package:revoke',
    { sha256: digest, reason: 'malicious', basis: { advisory: 'QA-1' } }, revocationKey), 201);
  expect(await json(await f.call('POST', '/v1/package-artifacts/revocations', 'owner package:revoke',
    { sha256: digest, reason: 'malicious', basis: { advisory: 'QA-1' } }, revocationKey), 200)).toEqual(revoked);
  for (const rollbackOf of [g1.generation, g3.generation]) {
    const rejected = await json(await plan(f, id, { operation: 'rollback', rollbackOf,
      expectedGeneration: g4.generation }), 201);
    expect(rejected.generation).toMatchObject({ state: 'rejected', terminalReason: 'artifact-revoked' });
    expect((await apply(f, id, rejected.generation.generation)).status).toBe(409);
  }
  expect(await readFile(join(f.rootOf(target), 'node_modules/p/index.js'), 'utf8')).toContain('p@2.0.0');
  const replay = await json(await f.call('POST', `/v1/package-locks/${l1.lock}/replays`, 'owner', undefined,
    `replay-${randomUUID()}`), 201);
  expect(replay).toMatchObject({ outcome: 'unavailable', artifacts: [expect.objectContaining({ result: 'revoked' })] });
  const fresh = await installation(f, `qa-root-${randomUUID()}`);
  expect((await json(await plan(f, fresh, { operation: 'install', lock: l1.lock }), 201)).generation.terminalReason)
    .toBe('artifact-revoked');
  // The DB guard independently refuses to activate a generation that uses revoked bytes.
  await expect(contentPool.query(`UPDATE pkg.installation_generation SET state = 'superseded'
    WHERE id = $1`, [g1.generation])).rejects.toThrow();

  // Authority revocation: an eligible plan staged before revocation cannot switch afterwards.
  const g5 = (await json(await plan(f, id, { operation: 'rollback', rollbackOf: g2.generation,
    expectedGeneration: g4.generation }), 201)).generation;
  expect(g5.state).toBe('planned');
  await expect(f.store().apply(f.owner.id, id, g5.generation, async () => false)).rejects.toThrow(PackageInstallDenied);
  expect((await json(await f.call('GET', `/v1/package-installations/${id}/generations/${g5.generation}`, 'owner'),
    200)).state).toBe('staged');
  expect(await mountTarget(f, target, 'node_modules/p')).toContain(g4.generation);
  await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [f.owner.id]);
  expect((await apply(f, id, g5.generation)).status).toBe(403);
  expect((await plan(f, id, { operation: 'rollback', rollbackOf: g2.generation, expectedGeneration: g4.generation }))
    .status).toBe(403);
  expect((await f.call('GET', `/v1/package-installations/${id}`, 'owner')).status).toBe(403);
  expect(await mountTarget(f, target, 'node_modules/p')).toContain(g4.generation);
  await accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [f.owner.id]);
  expect((await json(await apply(f, id, g5.generation), 200)).state).toBe('active');
});

test('PKG17: Account consent withdrawal fences a staged rollback through the real Main API', async () => {
  const f = await fixture({ consent: { versions: { '1.0.0': {}, '2.0.0': {} } } });
  const target = `qa-root-${randomUUID()}`;
  const id = await installation(f, target);
  const first = await resolveLock(f, { consent: '1.0.0' });
  await verifiedReplay(f, first.lock);
  const second = await resolveLock(f, { consent: '2.0.0' });
  await verifiedReplay(f, second.lock);
  const g1 = (await json(await plan(f, id, { operation: 'install', lock: first.lock }), 201)).generation;
  await json(await apply(f, id, g1.generation), 200);
  const g2 = (await json(await plan(f, id, { operation: 'update', lock: second.lock,
    expectedGeneration: g1.generation }), 201)).generation;
  await json(await apply(f, id, g2.generation), 200);

  const env = qaEnvironment();
  const databases = await cloneQaAccountAccessDatabases(env.runId);
  const account = await startAccount({ pool: { connectionString: databases.urls.account, max: 8 },
    secret: env.secret, resource: env.resource });
  try {
    const scopes = 'openid package:read package:install offline_access';
    const client = await account.nativeApp('Package rollback App', scopes);
    const verifierClient = await account.workloadApp('Package Main verifier', ['package:read']);
    const member = await account.signUp('package-consent');
    const issued = await account.issue(client.client_id, member, scopes);
    const verifier = new AccountAssertionVerifier(account.verifierConfig(verifierClient));
    await accessPool.query(`UPDATE access.principal SET account_issuer = $1, account_subject = $2
      WHERE id = $3`, [account.issuer, member.id, f.owner.id]);
    const real = f.withAccount(verifier);
    expect((await real('GET', `/v1/package-installations/${id}`, issued.access_token)).status).toBe(200);
    const rollback = await json(await real('POST', `/v1/package-installations/${id}/generations`,
      issued.access_token, { operation: 'rollback', lock: null, rollbackOf: g1.generation,
        expectedGeneration: g2.generation, userData: [], approveHooks: [] },
    `consent-rollback-${randomUUID()}`), 201);
    expect(rollback.generation.state).toBe('planned');
    const consentsResponse = await fetch(`${account.local}/api/auth/oauth2/get-consents`,
      { headers: { cookie: member.cookie } });
    expect(consentsResponse.status).toBe(200);
    const consents = await consentsResponse.json() as Array<{ id: string; clientId: string }>;
    const consent = consents.find(item => item.clientId === client.client_id);
    expect(consent?.id).toBeTruthy();
    expect((await account.post('/api/auth/oauth2/delete-consent', { id: consent!.id },
      member.cookie)).status).toBe(200);
    expect(await account.introspect(verifierClient, issued.access_token)).toEqual({ active: false });
    expect((await real('POST', `/v1/package-installations/${id}/generations/`
      + `${rollback.generation.generation}/apply`, issued.access_token)).status).toBe(401);
    expect((await real('GET', `/v1/package-installations/${id}`, issued.access_token)).status).toBe(401);
    expect(await mountTarget(f, target, 'node_modules/consent')).toContain(g2.generation);
    expect(await readFile(join(f.rootOf(target), 'node_modules/consent/index.js'), 'utf8'))
      .toContain('consent@2.0.0');
  } finally {
    await account.stop();
    await databases.close();
  }
}, 60_000);
