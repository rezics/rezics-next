import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { NpmResolutionStore } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { npmBytes, npmRegistryRequest } from '../fixtures/npm-registry-scenarios.ts';
import { syntheticNpmFetcher, syntheticTarball, type SyntheticNpmFaults,
  type SyntheticNpmRegistry } from '../fixtures/npm-registry-synthetic.ts';

const registry: SyntheticNpmRegistry = {
  a: { versions: { '1.0.0': { deps: { c: '^1.0.0' } } } },
  b: { versions: { '1.0.0': { deps: { c: '^2.0.0' }, peers: { host: '^1.0.0' } } } },
  c: { tags: { latest: '2.1.0' }, versions: { '1.0.0': {}, '1.4.0': {}, '2.0.0': {}, '2.1.0': {} } },
  host: { versions: { '1.0.0': {}, '2.0.0': {} } },
};
const body = (dependencies: Record<string, string>, strategy = 'npm-hoisted') => npmRegistryRequest({
  name: 'api', strategy, native: false, manifest: { name: 'api-root', version: '1.0.0', dependencies },
  expect: { status: 'solved', correspondence: null, allowedDivergences: [] } });

test('PKG03/PKG04/PKG12/IAM10: npm registry range receipts are captured once, private, replayable and revalidated', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const queries: string[] = [];
  const counted = new Proxy(contentPool, { get(target, property, receiver) {
    if (property === 'query') return (text: string, values?: unknown[]) => {
      queries.push(text.replace(/\s+/g, ' ').trim().split(' ')[0]!);
      return target.query(text, values);
    };
    return Reflect.get(target, property, receiver);
  } });
  const faults: SyntheticNpmFaults = { tamper: new Set(), unavailable: new Set() };
  const provider = syntheticNpmFetcher(registry, faults);
  const issuer = 'https://qa-npm-registry.test';
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const app = createMainApp(fuseki, {
    environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp/npm-registry-unused' },
    account: { verify: async (request: Request, required: readonly string[]) => {
      const bearer = request.headers.get('authorization');
      if (bearer === 'Bearer owner-resolve' && required[0] === 'package:resolve') return owner;
      if (bearer === 'Bearer owner-read' && required[0] === 'package:read') return owner;
      if (bearer === 'Bearer other-read' && required[0] === 'package:read') return other;
      if (bearer === 'Bearer other-resolve' && required[0] === 'package:resolve') return other;
      throw new AccountAssertionDenied('package scope is unavailable');
    } },
    access: new AccessAdmissionRegistry(accessPool),
    packageNpmResolutions: new NpmResolutionStore(counted as Pool, { fetcher: provider.fetcher }),
  });
  const write = (token: string, key: string, requestBody: unknown) => app.handle(new Request(
    'http://main.local/v1/package-resolutions/npm', { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(requestBody) }));
  const read = (token: string, id: string) => app.handle(new Request(
    `http://main.local/v1/package-resolutions/npm/${id}`, { headers: { authorization: `Bearer ${token}` } }));
  const rows = async () => Number((await contentPool.query(
    'SELECT count(*) FROM pkg.npm_resolution WHERE principal_id = $1', [ownerId])).rows[0].count);
  try {
    await migrateContent(contentPool);
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3),($4,$2,$5)`, [ownerId, issuer, owner.subject, otherId, other.subject]);
    const request = body({ a: '^1.0.0', b: '^1.0.0', host: '^1.0.0' });
    const key = `npm-registry-${randomUUID()}`;
    expect((await write('owner-read', key, request)).status).toBe(401);
    expect(provider.requests).toEqual([]);

    queries.length = 0;
    const created = await write('owner-resolve', key, request);
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const receipt = await created.json() as { replayed: boolean; resolution: { profile: string; resolution: string;
      requestDigest: string; outcome: { status: string; artifactVerification: string; resolutionId: string;
        instances: Array<{ path: string; version: string; peerHosts: Array<{ hostPath: string | null }> }>;
        sourceSnapshot: { packuments: unknown[]; artifacts: Array<{ status: string }> } } } };
    expect(receipt.replayed).toBe(false);
    expect(receipt.resolution.profile).toBe('npm-registry-resolution-receipt-v1');
    expect(receipt.resolution.outcome).toMatchObject({ status: 'solved', artifactVerification: 'verified' });
    expect(Object.fromEntries(receipt.resolution.outcome.instances.map(item => [item.path, item.version]))).toEqual({
      '': '1.0.0', 'node_modules/a': '1.0.0', 'node_modules/b': '1.0.0', 'node_modules/b/node_modules/c': '2.1.0',
      'node_modules/c': '1.4.0', 'node_modules/host': '1.0.0' });
    expect(receipt.resolution.outcome.instances.find(item => item.path === 'node_modules/b')!.peerHosts)
      .toEqual([{ name: 'host', spec: '^1.0.0', optional: false, hostPath: 'node_modules/host' }]);
    // One request per reached packument and per unique selected tarball; one indexed read, insert and read.
    expect(provider.requests.filter(url => !url.endsWith('.tgz')).sort()).toEqual(['a', 'b', 'c', 'host']
      .map(name => `https://registry.npmjs.org/${name}`));
    expect(provider.requests.filter(url => url.endsWith('.tgz'))).toHaveLength(5);
    expect(receipt.resolution.outcome.sourceSnapshot.artifacts.every(item => item.status === 'verified')).toBe(true);
    expect(queries).toEqual(['SELECT', 'INSERT', 'SELECT']);
    const id = receipt.resolution.resolution.split('/').at(-1)!;

    const fetched = provider.requests.length;
    queries.length = 0;
    const replay = await write('owner-resolve', key, request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...receipt, replayed: true });
    expect(provider.requests).toHaveLength(fetched);
    expect(queries).toEqual(['SELECT']);
    queries.length = 0;
    const exact = await read('owner-read', id);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual(receipt.resolution);
    expect(queries).toEqual(['SELECT']);
    expect((await read('other-read', id)).status).toBe(404);
    expect(provider.requests).toHaveLength(fetched);

    expect((await write('owner-resolve', key, body({ a: '^1.0.0' }))).status).toBe(409);
    const before = await rows();
    const malformed = await write('owner-resolve', `npm-registry-${randomUUID()}`, { ...request,
      manifest: { ...request.manifest, sha256: '0'.repeat(64) } });
    expect(malformed.status).toBe(422);
    expect((await write('owner-resolve', `npm-registry-${randomUUID()}`, { ...request, artifacts: undefined })).status)
      .toBe(400);
    expect((await write('owner-resolve', `npm-registry-${randomUUID()}`, { ...request,
      manifest: npmBytes('{"name":"Bad Name","version":"1.0.0"}') })).status).toBe(422);
    expect(await rows()).toBe(before);
    expect(provider.requests).toHaveLength(fetched);

    const refused = await write('owner-resolve', `npm-registry-${randomUUID()}`, body({ a: '^1.0.0' }, 'pnpm-isolated'));
    expect(refused.status).toBe(201);
    expect((await refused.json()).resolution.outcome).toMatchObject({ status: 'unsupported-semantics',
      unsupportedClauses: ['strategy:pnpm-isolated'], instances: [], artifactVerification: 'not-reached' });
    expect(provider.requests).toHaveLength(fetched);

    const raceKey = `npm-registry-${randomUUID()}`;
    const race = await Promise.all([write('owner-resolve', raceKey, request), write('owner-resolve', raceKey, request)]);
    expect(race.map(response => response.status).sort()).toEqual([200, 201]);
    const raced = await Promise.all(race.map(async response => (await response.json()).resolution.resolution));
    expect(raced[0]).toBe(raced[1]);
    expect(Number((await contentPool.query('SELECT count(*) FROM pkg.npm_resolution WHERE principal_id = $1 AND idempotency_key = $2',
      [ownerId, raceKey])).rows[0].count)).toBe(1);

    faults.tamper!.add(syntheticTarball('c', '2.1.0'));
    const tampered = await write('owner-resolve', `npm-registry-${randomUUID()}`, request);
    expect((await tampered.json()).resolution.outcome).toMatchObject({ status: 'inconsistent-source-data',
      artifactVerification: 'failed', instances: [], edges: [],
      issues: [{ kind: 'integrity-mismatch', name: 'c', version: '2.1.0' }] });
    faults.tamper!.clear();
    faults.unavailable!.add('c');
    const unavailable = await write('owner-resolve', `npm-registry-${randomUUID()}`, request);
    const incomplete = (await unavailable.json()).resolution;
    expect(incomplete.outcome).toMatchObject({ status: 'incomplete-source-data', instances: [],
      issues: [{ kind: 'unavailable-packument', name: 'c' }] });
    faults.unavailable!.clear();
    const incompleteRead = await read('owner-read', incomplete.resolution.split('/').at(-1));
    expect(await incompleteRead.json()).toEqual(incomplete);

    await expect(contentPool.query(`UPDATE pkg.npm_resolution SET outcome = '{}'::jsonb WHERE id = $1`, [id]))
      .rejects.toThrow();
    await expect(contentPool.query('DELETE FROM pkg.npm_resolution WHERE id = $1', [id])).rejects.toThrow();

    const beforeInactive = provider.requests.length;
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [ownerId]);
    expect((await read('owner-read', id)).status).toBe(403);
    expect((await write('owner-resolve', `npm-registry-${randomUUID()}`, request)).status).toBe(403);
    expect((await write('owner-resolve', key, request)).status).toBe(403);
    expect(provider.requests).toHaveLength(beforeInactive);
  } finally {
    await Promise.all([contentPool.end(), accessPool.end()]);
  }
});
