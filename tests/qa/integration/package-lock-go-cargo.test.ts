import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { CargoResolutionStore } from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { GoMvsResolutionStore } from '../../../services/main/src/modules/package/go-mvs.ts';
import { GoProxyCaptureStore } from '../../../services/main/src/modules/package/go-proxy-capture.ts';
import { type IncludedGoSumdbLookup } from '../../../services/main/src/modules/package/go-sumdb-lookup.ts';
import { GoSumdbTrustStore } from '../../../services/main/src/modules/package/go-sumdb-trust.ts';
import { PackageArtifactStore } from '../../../services/main/src/modules/package/lock-artifacts.ts';
import { goModuleZipH1 } from '../../../services/main/src/modules/package/lock-go-zip.ts';
import { PackageLockStore } from '../../../services/main/src/modules/package/lock.ts';
import { NpmResolutionStore } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { cargoIndexFile } from '../fixtures/cargo-links-snapshot.ts';
import goFixture from '../fixtures/go-sumdb-x-sync-v0.3.0.json';
import { tarGz } from './package-install-fixtures.ts';

const root = resolve(import.meta.dir, '../../..');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('PKG14: Go signed ZIP and Cargo index archive locks replay exact bytes across mutable files', async () => {
  for (const name of ['REZICS_QA_RUN_ID', 'CONTENT_DATABASE_URL', 'ACCESS_DATABASE_URL', 'FUSEKI_URL',
    'MAIN_S3_ENDPOINT', 'MAIN_S3_BUCKET', 'MAIN_S3_ACCESS_KEY', 'MAIN_S3_SECRET_KEY']) {
    if (!Bun.env[name]) throw new Error('Run through the isolated QA integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 8 });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 4 });
  try {
    await migrateContent(pool);
    const owner = { issuer: 'https://qa-multilock.test', subject: randomUUID(), id: randomUUID() };
    const other = { issuer: owner.issuer, subject: randomUUID(), id: randomUUID() };
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3),($4,$2,$5)`, [owner.id, owner.issuer, owner.subject, other.id, other.subject]);
    // The other caller is refused by the handler, after the closed gate.
    await grantRecordedPlatformUse(accessPool, owner.id, ['developer-extras']);
    await grantRecordedPlatformUse(accessPool, other.id, ['developer-extras']);
    const zip = await readFile(join(root, 'tests/qa/fixtures/go-sumdb-x-sync-v0.3.0.zip'));
    const signedZip = Buffer.from((goFixture.included as IncludedGoSumdbLookup).recordTextBase64,
      'base64').toString().split('\n')[0]!.split(' ')[2]!;
    expect(goModuleZipH1(zip, 'golang.org/x/sync', 'v0.3.0')).toBe(signedZip);
    const crate = tarGz([{ path: 'leaf-1.0.0/Cargo.toml',
      content: '[package]\nname = "leaf"\nversion = "1.0.0"\n' }]);
    let changedGo = false;
    let changedCargo = false;
    const goUrl = 'https://proxy.golang.org/golang.org/x/sync/@v/v0.3.0.zip';
    const cargoUrl = 'https://static.crates.io/crates/leaf/leaf-1.0.0.crate';
    const archiveFetch = (async (url: RequestInfo | URL) => {
      if (String(url) === goUrl) return new Response(changedGo ? Buffer.from('changed ZIP') : zip);
      if (String(url) === cargoUrl) return new Response(changedCargo ? Buffer.from('changed crate') : crate);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const proxy = (async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith('/@v/list')) return new Response('v0.3.0\n');
      if (value.endsWith('.info')) return new Response(JSON.stringify({ Version: 'v0.3.0',
        Time: '2022-10-01T00:00:00Z' }));
      if (value.endsWith('.mod')) return new Response('module golang.org/x/sync\n\ngo 1.17\n');
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const captures = new GoProxyCaptureStore(pool, proxy);
    const go = new GoMvsResolutionStore(pool, captures);
    const cargo = new CargoResolutionStore(pool);
    const sumdb = new GoSumdbTrustStore(pool, captures,
      (async () => goFixture.included as IncludedGoSumdbLookup) as
        ConstructorParameters<typeof GoSumdbTrustStore>[2],
      (async () => []) as ConstructorParameters<typeof GoSumdbTrustStore>[3],
      (async () => goFixture.latest) as ConstructorParameters<typeof GoSumdbTrustStore>[4]);
    const namespaces = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
    await namespaces('package/artifact/public/').initialize();
    const locks = new PackageLockStore(pool, new NpmResolutionStore(pool),
      new PackageArtifactStore(pool, namespaces), { fetcher: archiveFetch, cargo, go, sumdb, captures });
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL!);
    const app = createMainApp(fuseki, {
      environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!,
        routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! }, objectDirectory: '.temp/package-lock-unused' },
      platformAccess: new AccessExposure(accessPool),
      account: { verify: async (request: Request, scopes: readonly string[]) => {
        const [who, scope] = (request.headers.get('authorization') ?? '').replace('Bearer ', '').split(' ');
        // The exposure gate verifies with an empty scope list; a handler still rejects a mismatch.
        if (scopes.length > 0 && scope !== scopes[0]) throw new AccountAssertionDenied('wrong package scope');
        if (who === 'owner') return { issuer: owner.issuer, subject: owner.subject };
        if (who === 'other') return { issuer: other.issuer, subject: other.subject };
        throw new AccountAssertionDenied('unknown package token');
      } },
      access: new AccessAdmissionRegistry(accessPool), packageCaptures: captures,
      packageResolutions: go, packageCargoResolutions: cargo, packageVerifications: sumdb,
      packageLocks: locks,
    });
    const call = (method: string, path: string, scope: string, body?: unknown,
      key = `multi-${randomUUID()}`, who = 'owner') => app.handle(new Request(`http://main.local${path}`,
      { method, headers: { authorization: `Bearer ${who} ${scope}`,
        'content-type': 'application/json', 'idempotency-key': key },
      ...body === undefined ? {} : { body: JSON.stringify(body) } }));
    const parse = async (response: Response, status: number) => {
      const text = await response.text();
      expect({ status: response.status, error: response.status === status ? '' : text })
        .toEqual({ status, error: '' });
      return JSON.parse(text) as Record<string, any>;
    };

    const capture = await parse(await call('POST', '/v1/package-sources/go', 'package:capture',
      { profile: 'go-module-proxy-capture-v1', path: 'golang.org/x/sync', version: 'v0.3.0' }), 201);
    const captureId = capture.capture.capture.split('/').at(-1)!;
    const mainMod = 'module example.com/root\n\ngo 1.17\n\nrequire golang.org/x/sync v0.3.0\n';
    const solvedGo = await parse(await call('POST', '/v1/package-resolutions/from-captures',
      'package:resolve', { profile: 'go-mvs-from-main-pruned-captures-v4',
        mainManifestBase64: Buffer.from(mainMod).toString('base64'), captures: [captureId] }), 201);
    expect(solvedGo.resolution.outcome.status).toBe('solved');
    const goId = solvedGo.resolution.resolution.split('/').at(-1)!;
    const goBody = { profile: 'rezics-package-lock-v1', segments: [{ ecosystem: 'go', resolution: goId,
      scope: { kind: 'process', label: 'go' } }] };
    expect((await call('POST', '/v1/package-locks', 'package:resolve', goBody)).status).toBe(422);
    await parse(await call('POST', `/v1/package-sources/go/${captureId}/verify`, 'package:verify'), 201);
    const goLock = await parse(await call('POST', '/v1/package-locks', 'package:resolve', goBody), 201);
    expect(goLock.manifest.artifacts[0].integrity).toEqual({ basis: 'registry-digest',
      algorithm: 'go-h1', value: signedZip });
    expect((await call('GET', `/v1/package-locks/${goLock.lock}`, 'package:read', undefined,
      undefined, 'other')).status).toBe(404);
    const goReplay = await parse(await call('POST', `/v1/package-locks/${goLock.lock}/replays`,
      'package:verify'), 201);
    expect(goReplay).toMatchObject({ outcome: 'verified', artifacts: [
      expect.objectContaining({ result: 'verified', locator: goUrl })] });
    changedGo = true;
    expect((await parse(await call('POST', `/v1/package-locks/${goLock.lock}/replays`,
      'package:verify'), 201)).artifacts[0].result).toBe('digest-mismatch');

    const manifest = '[package]\nname = "root"\nversion = "0.1.0"\nedition = "2021"\nresolver = "2"\n'
      + '[dependencies]\nleaf = { version = "=1.0.0", registry = "snapshot" }\n';
    const cargoRequest = { profile: 'cargo-index-exact-resolver2-v1',
      registryIndexUrl: 'https://index.crates.io/',
      manifestBase64: Buffer.from(manifest).toString('base64'), manifestSha256: digest(Buffer.from(manifest)),
      indexFiles: [cargoIndexFile('leaf', [{ name: 'leaf', vers: '1.0.0', cksum: digest(crate),
        deps: [], features: {}, yanked: false, v: 1 }])],
      host: 'x86_64-unknown-linux-gnu', target: 'x86_64-unknown-linux-gnu',
      features: [], defaultFeatures: true };
    const solvedCargo = await parse(await call('POST', '/v1/package-resolutions/cargo',
      'package:resolve', cargoRequest), 201);
    expect(solvedCargo.resolution.outcome.status).toBe('solved');
    const cargoId = solvedCargo.resolution.resolution.split('/').at(-1)!;
    const cargoBody = { profile: 'rezics-package-lock-v1', segments: [{ ecosystem: 'cargo', resolution: cargoId,
      scope: { kind: 'path', label: 'cargo' } }] };
    const cargoLock = await parse(await call('POST', '/v1/package-locks', 'package:resolve', cargoBody), 201);
    expect(cargoLock.manifest.artifacts[0].integrity).toEqual({ basis: 'registry-digest',
      algorithm: 'sha256', value: digest(crate) });
    const cargoReplay = await parse(await call('POST', `/v1/package-locks/${cargoLock.lock}/replays`,
      'package:verify'), 201);
    expect(cargoReplay).toMatchObject({ outcome: 'verified', artifacts: [
      expect.objectContaining({ result: 'verified', locator: cargoUrl })] });
    changedCargo = true;
    expect((await parse(await call('POST', `/v1/package-locks/${cargoLock.lock}/replays`,
      'package:verify'), 201)).artifacts[0].result).toBe('digest-mismatch');
    changedGo = false;
    changedCargo = false;
    const mixed = await parse(await call('POST', '/v1/package-locks', 'package:resolve', {
      profile: 'rezics-package-lock-v1', segments: [
        { ecosystem: 'go', resolution: goId, scope: { kind: 'process', label: 'go-runtime' } },
        { ecosystem: 'cargo', resolution: cargoId, scope: { kind: 'path', label: 'rust-build' } },
      ],
    }), 201);
    expect(mixed.manifest.segments.map((item: any) => [item.ecosystem, item.scope.kind]))
      .toEqual([['go', 'process'], ['cargo', 'path']]);
    expect(mixed.manifest.artifacts.map((item: any) => item.ecosystem)).toEqual(['go', 'cargo']);
    expect((await parse(await call('POST', `/v1/package-locks/${mixed.lock}/replays`,
      'package:verify'), 201)).artifacts.map((item: any) => item.result))
      .toEqual(['verified', 'verified']);
  } finally { await Promise.all([pool.end(), accessPool.end()]); }
}, 30_000);
