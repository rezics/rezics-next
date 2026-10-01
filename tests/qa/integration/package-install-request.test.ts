import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { discoverOAuthScopes } from '../../../services/account/src/oauth-scopes.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { CargoResolutionStore } from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { PackageArtifactStore } from '../../../services/main/src/modules/package/lock-artifacts.ts';
import { PackageLockStore } from '../../../services/main/src/modules/package/lock.ts';
import { NpmResolutionStore } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { cargoIndexFile, type CargoIndexEntry } from '../fixtures/cargo-links-snapshot.ts';
import { syntheticNpmFetcher } from '../fixtures/npm-registry-synthetic.ts';
import { tarGz } from './package-install-fixtures.ts';

const root = resolve(import.meta.dir, '../../..');
const nativeId = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
const shortId = (value: string) => value.split('/').at(-1)!;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('WORK07: Main Version recommendations resolve eligible npm and Cargo artifacts, and refuse an ineligible release without a lock', async () => {
  for (const name of ['REZICS_QA_RUN_ID', 'CONTENT_DATABASE_URL', 'ACCESS_DATABASE_URL', 'FUSEKI_URL',
    'MAIN_S3_ENDPOINT', 'MAIN_S3_BUCKET', 'MAIN_S3_ACCESS_KEY', 'MAIN_S3_SECRET_KEY']) {
    if (!Bun.env[name]) throw new Error('Run through the isolated QA integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 8 });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 4 });
  const objectDirectory = join(root, '.temp', `package-install-request-${randomUUID()}`);
  try {
    expect(await discoverOAuthScopes()).toContain('package:recommendation-set');
    await migrateContent(pool);
    await mkdir(objectDirectory, { recursive: true });
    const issuer = 'https://qa-package-install-request.test';
    const owner = { id: randomUUID(), subject: randomUUID() };
    const other = { id: randomUUID(), subject: randomUUID() };
    const actor = nativeId();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3), ($4, $2, $5)`, [owner.id, issuer, owner.subject, other.id, other.subject]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [actor]);
    const grant = async (principalId: string, scope: string, action: string) => {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), principalId, actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), actor, scope, action]);
    };
    await grant(owner.id, 'work:create:root', 'work.create');
    const registry = syntheticNpmFetcher({
      'rezics-work07-eligible': { versions: { '1.0.0': {} } },
      'rezics-work07-platform': { versions: { '1.0.0': { os: ['win32'] } } },
    });
    const npm = new NpmResolutionStore(pool, { fetcher: registry.fetcher });
    const cargo = new CargoResolutionStore(pool);
    const namespaces = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
    await namespaces('package/artifact/public/').initialize();
    const crate = tarGz([{ path: 'leaf-1.0.0/Cargo.toml',
      content: '[package]\nname = "leaf"\nversion = "1.0.0"\n' }]);
    const cargoUrl = 'https://static.crates.io/crates/leaf/leaf-1.0.0.crate';
    const archiveFetcher = (async (input: RequestInfo | URL) => String(input) === cargoUrl
      ? new Response(crate) : registry.fetcher(input, { redirect: 'error' })) as typeof fetch;
    let loseRecommendationAck = false;
    const baseFuseki = new FusekiClient(Bun.env.FUSEKI_URL!);
    const fuseki = new Proxy(baseFuseki, { get(target, property) {
      if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
        const result = await target.commandWithReceipt(envelope);
        if (loseRecommendationAck && envelope.update.includes('PackageReleaseRecommendationSetEvent')) {
          loseRecommendationAck = false;
          throw new Error('lost graph acknowledgement after durable command');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as FusekiClient;
    const mainEnvironment = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! }, objectDirectory };
    await provisionFixtureAuthor(mainEnvironment, actor);
    const account = { verify: async (request: Request) => {
      const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/, '');
      if (token === 'owner') return { issuer, subject: owner.subject };
      if (token === 'other') return { issuer, subject: other.subject };
      throw new AccountAssertionDenied('unknown test token');
    } };
    const locks = new PackageLockStore(pool, npm, new PackageArtifactStore(pool, namespaces),
      { fetcher: archiveFetcher, cargo });
    const app = createMainApp(fuseki, { environment: mainEnvironment, account, access: new AccessAdmissionRegistry(accessPool),
      packageNpmResolutions: npm, packageCargoResolutions: cargo, packageLocks: locks });
    const call = (method: string, path: string, body?: unknown, key = randomUUID(), who = 'owner') => app.handle(
      new Request(`http://main.local${path}`, { method, headers: { authorization: `Bearer ${who}`,
        'content-type': 'application/json', 'idempotency-key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const parse = async <T extends Record<string, any>>(response: Response, status: number): Promise<T> => {
      const text = await response.text();
      expect({ status: response.status, error: response.status === status ? '' : text })
        .toEqual({ status, error: '' });
      return JSON.parse(text) as T;
    };

    const created = await parse<{ work: string; mainVersion: string; workRevision: string }>(
      await call('POST', '/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work', language: 'en', title: 'WORK07 package install',
        actingSubject: actor }, `work-${randomUUID()}`), 201);
    const editScope = `work:edit:${created.work}`;
    const readScope = `work:read:${created.work}`;
    await grant(owner.id, editScope, 'work.edit');
    await grant(owner.id, readScope, 'work.read');
    const path = `/v1/main-versions/${shortId(created.mainVersion)}/package-release-recommendations`;
    const currentReadPath = `${path}?actingSubject=${encodeURIComponent(actor)}`;
    const cargoIndex = cargoIndexFile('leaf', [{ name: 'leaf', vers: '1.0.0', cksum: sha256(crate),
      deps: [], features: {}, yanked: false, v: 1 } as CargoIndexEntry]);
    const eligible = [
      { ecosystem: 'npm', packageName: 'rezics-work07-eligible',
        selector: { kind: 'exact-release', value: '1.0.0' } },
      { ecosystem: 'cargo', packageName: 'leaf', selector: { kind: 'exact-release', value: '1.0.0' } },
    ];
    const firstSetBody = { profile: 'main-package-release-recommendation-v1', work: created.work,
      expectedRevision: null, recommendations: eligible, actingSubject: actor };
    expect((await call('POST', path, firstSetBody, `denied-${randomUUID()}`, 'other')).status).toBe(403);
    const overLimit = await call('POST', path, { ...firstSetBody, recommendations: Array.from({ length: 17 }, (_, index) => ({
      ecosystem: 'npm', packageName: `over-limit-${index}`,
      selector: { kind: 'exact-release', value: '1.0.0' },
    })) }, `over-limit-${randomUUID()}`);
    expect(overLimit.status).toBe(400);
    const firstSet = await parse<{ revision: string; receipt: string; replayed: boolean }>(
      await call('POST', path, firstSetBody, `recommendations-${randomUUID()}`), 201);
    expect(firstSet).toMatchObject({ replayed: false, receipt: expect.stringContaining('urn:rezics:receipt:') });
    const exactRead = await parse<{ work: string; mainVersion: string; revision: string; recommendations: unknown[] }>(
      await call('GET', `${path}/${shortId(firstSet.revision)}?actingSubject=${encodeURIComponent(actor)}`), 200);
    expect(exactRead.recommendations).toHaveLength(2);
    expect(exactRead).toMatchObject({ work: created.work, mainVersion: created.mainVersion,
      revision: firstSet.revision, recommendations: eligible });
    expect(registry.requests).toHaveLength(0);

    const environment = { os: 'linux', cpu: 'x64', nodeVersion: '26.8.2',
      cargoHost: 'x86_64-unknown-linux-gnu', cargoTarget: 'x86_64-unknown-linux-gnu' };
    const installBody = { profile: 'main-version-package-install-request-v1', mainVersion: created.mainVersion,
      recommendationRevision: firstSet.revision, actingSubject: actor, environment,
      cargoIndexFiles: [cargoIndex], cargoArtifacts: [{ name: 'leaf', version: '1.0.0',
        bytesBase64: crate.toString('base64') }] };
    const beforeLockCount = Number((await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pkg.lock WHERE principal_id = $1', [owner.id])).rows[0]!.count);
    const partial = await parse<{ status: string; reason: string; lock: string | null }>(
      await call('POST', '/v1/package-install-requests', { ...installBody,
        cargoArtifacts: [{ name: 'leaf', version: '1.0.0', bytesBase64: Buffer.from('tampered').toString('base64') }] },
      `partial-${randomUUID()}`), 200);
    expect(partial).toMatchObject({ status: 'refused', reason: 'artifact-unverified', lock: null });
    expect(Number((await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pkg.lock WHERE principal_id = $1', [owner.id])).rows[0]!.count))
      .toBe(beforeLockCount);

    const solved = await parse<{ status: string; resolutions: Array<{ ecosystem: string }>;
      lock: string; lockSha256: string; replayed: boolean }>(await call('POST', '/v1/package-install-requests',
      installBody, `install-${randomUUID()}`), 201);
    expect(solved).toMatchObject({ status: 'resolved', replayed: false,
      resolutions: [{ ecosystem: 'npm' }, { ecosystem: 'cargo' }], lockSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(registry.requests).toHaveLength(4);
    const locked = await parse<{ manifest: { artifacts: Array<{ ecosystem: string; integrity: { value: string } }> } }>(
      await call('GET', `/v1/package-locks/${shortId(solved.lock)}`), 200);
    expect(locked.manifest.artifacts.map(item => item.ecosystem).sort()).toEqual(['cargo', 'npm']);
    expect(locked.manifest.artifacts.find(item => item.ecosystem === 'cargo')!.integrity.value)
      .toBe(sha256(crate));
    const replay = await parse<{ outcome: string; artifacts: Array<{ result: string }> }>(
      await call('POST', `/v1/package-locks/${shortId(solved.lock)}/replays`, undefined,
        `replay-${randomUUID()}`), 201);
    expect(replay).toMatchObject({ outcome: 'verified', artifacts: [{ result: 'verified' }, { result: 'verified' }] });

    const staleResponse = await call('POST', path, { ...firstSetBody,
      recommendations: [{ ecosystem: 'npm', packageName: 'other',
        selector: { kind: 'exact-release', value: '1.0.0' } }] }, `stale-${randomUUID()}`);
    expect(staleResponse.status).toBe(409);
    const stillCurrent = await parse<{ revision: string }>(await call('GET', currentReadPath), 200);
    expect(stillCurrent.revision).toBe(firstSet.revision);

    const secondSetBody = (name: string) => ({ ...firstSetBody, expectedRevision: firstSet.revision,
      recommendations: [{ ecosystem: 'npm', packageName: name,
        selector: { kind: 'exact-release', value: '1.0.0' } }] });
    const concurrent = await Promise.all([
      call('POST', path, secondSetBody('winner-a'), `concurrent-a-${randomUUID()}`),
      call('POST', path, secondSetBody('winner-b'), `concurrent-b-${randomUUID()}`),
    ]);
    expect(concurrent.map(item => item.status).sort()).toEqual([201, 409]);

    const afterConcurrent = await parse<{ revision: string }>(await call('GET', currentReadPath), 200);
    const recoveryKey = `recovery-${randomUUID()}`;
    loseRecommendationAck = true;
    const recovered = await parse<{ revision: string; receipt: string }>(await call('POST', path,
      { ...firstSetBody, expectedRevision: afterConcurrent.revision,
        recommendations: [{ ecosystem: 'npm', packageName: 'rezics-work07-eligible',
          selector: { kind: 'exact-release', value: '1.0.0' } }] }, recoveryKey), 201);
    const replayedRecovery = await parse<{ revision: string; replayed: boolean }>(await call('POST', path,
      { ...firstSetBody, expectedRevision: afterConcurrent.revision,
        recommendations: [{ ecosystem: 'npm', packageName: 'rezics-work07-eligible',
          selector: { kind: 'exact-release', value: '1.0.0' } }] }, recoveryKey), 200);
    expect(replayedRecovery).toMatchObject({ revision: recovered.revision, replayed: true });

    const ineligibleBody = { profile: 'main-package-release-recommendation-v1', work: created.work,
      expectedRevision: recovered.revision, recommendations: [{ ecosystem: 'npm',
        packageName: 'rezics-work07-platform', selector: { kind: 'version-constraint', value: '^1.0.0' } }],
      actingSubject: actor };
    const ineligibleSet = await parse<{ revision: string }>(
      await call('POST', path, ineligibleBody, `platform-rec-${randomUUID()}`), 201);
    const beforeRefusal = Number((await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pkg.lock WHERE principal_id = $1', [owner.id])).rows[0]!.count);
    const refused = await parse<{ status: string; reason: string; lock: string | null; resolutions: unknown[] }>(
      await call('POST', '/v1/package-install-requests', { profile: 'main-version-package-install-request-v1',
        mainVersion: created.mainVersion, recommendationRevision: ineligibleSet.revision,
        actingSubject: actor, environment }, `ineligible-${randomUUID()}`), 200);
    expect(refused).toMatchObject({ status: 'refused', reason: 'no-eligible-release', lock: null, resolutions: [] });
    expect(Number((await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pkg.lock WHERE principal_id = $1', [owner.id])).rows[0]!.count))
      .toBe(beforeRefusal);
    expect(registry.requests).toHaveLength(6);

    const unsupportedSet = await parse<{ revision: string }>(await call('POST', path, {
      profile: 'main-package-release-recommendation-v1', work: created.work,
      expectedRevision: ineligibleSet.revision, recommendations: [{ ecosystem: 'go',
        packageName: 'example.org/module', selector: { kind: 'exact-release', value: 'v1.0.0' } }],
      actingSubject: actor,
    }, `unsupported-ecosystem-${randomUUID()}`), 201);
    const beforeUnsupported = Number((await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pkg.lock WHERE principal_id = $1', [owner.id])).rows[0]!.count);
    const unsupported = await parse<{ status: string; reason: string; lock: string | null }>(
      await call('POST', '/v1/package-install-requests', { profile: 'main-version-package-install-request-v1',
        mainVersion: created.mainVersion, recommendationRevision: unsupportedSet.revision,
        actingSubject: actor, environment }, `unsupported-install-${randomUUID()}`), 200);
    expect(unsupported).toMatchObject({ status: 'refused', reason: 'unsupported-ecosystem', lock: null });
    expect(Number((await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pkg.lock WHERE principal_id = $1', [owner.id])).rows[0]!.count))
      .toBe(beforeUnsupported);
  } finally {
    await Promise.all([pool.end(), accessPool.end()]);
    await rm(objectDirectory, { recursive: true, force: true });
  }
}, 180_000);
