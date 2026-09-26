import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied }
  from '../../../services/main/src/modules/account/verify-assertion.ts';
import { GoMvsResolutionStore }
  from '../../../services/main/src/modules/package/go-mvs.ts';

test('PKG05/PKG13/IAM10: bounded Go MVS snapshot resolution is private and immutable', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const issuer = 'https://qa-go-mvs.test';
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const app = createMainApp(fuseki, {
    environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
        routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp/go-mvs-unused' },
    account: { verify: async (request: Request, required: readonly string[]) => {
      const bearer = request.headers.get('authorization');
      if (bearer === 'Bearer owner-write' && required[0] === 'package:resolve') return owner;
      if (bearer === 'Bearer owner-read' && required[0] === 'package:read') return owner;
      if (bearer === 'Bearer other-read' && required[0] === 'package:read') return other;
      throw new AccountAssertionDenied('package scope is unavailable');
    } },
    access: new AccessAdmissionRegistry(accessPool),
    packageResolutions: new GoMvsResolutionStore(contentPool),
  });
  const requestBody = { profile: 'go-mvs-stable-unpruned-v1',
    mainModule: 'example.com/main', goDirective: '1.16',
    coverage: { complete: true, unsupportedClauses: [] },
    roots: [{ path: 'example.com/a', version: 'v1.0.0' },
      { path: 'example.com/b', version: 'v1.0.0' }],
    releases: [
      { path: 'example.com/a', version: 'v1.0.0',
        requirements: [{ path: 'example.com/c', version: 'v1.2.0' }] },
      { path: 'example.com/b', version: 'v1.0.0',
        requirements: [{ path: 'example.com/c', version: 'v1.3.0' }] },
      { path: 'example.com/c', version: 'v1.2.0', requirements: [] },
      { path: 'example.com/c', version: 'v1.3.0', requirements: [] },
      { path: 'example.com/c', version: 'v1.9.0', requirements: [] },
    ],
  };
  const write = (token: string, key: string, body: object) => app.handle(new Request(
    'http://main.local/v1/package-resolutions', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify(body) }));
  const read = (token: string, id: string) => app.handle(new Request(
    `http://main.local/v1/package-resolutions/${id}`,
    { headers: { authorization: `Bearer ${token}` } }));
  try {
    await migrateContent(contentPool);
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
    [ownerId, issuer, owner.subject, otherId, other.subject]);
    const key = `go-${randomUUID()}`;
    expect((await write('owner-read', key, requestBody)).status).toBe(401);
    const created = await write('owner-write', key, requestBody);
    expect(created.status).toBe(201);
    const saved = await created.json() as { resolution: { resolution: string;
      outcome: { status: string; buildList: Array<{ path: string; version: string }> };
      requestDigest: string }; replayed: boolean };
    expect(saved.replayed).toBe(false);
    expect(saved.resolution.outcome).toMatchObject({ status: 'solved', buildList: [
      { path: 'example.com/a', version: 'v1.0.0' },
      { path: 'example.com/b', version: 'v1.0.0' },
      { path: 'example.com/c', version: 'v1.3.0' },
    ] });
    const id = saved.resolution.resolution.split('/').at(-1)!;
    expect((await read('owner-write', id)).status).toBe(401);
    expect(await (await read('owner-read', id)).json()).toEqual(saved.resolution);
    expect((await read('other-read', id)).status).toBe(404);
    expect(await (await write('owner-write', key, requestBody)).json())
      .toEqual({ resolution: saved.resolution, replayed: true });
    expect((await write('owner-write', key, { ...requestBody,
      roots: [{ path: 'example.com/a', version: 'v1.0.0' }] })).status).toBe(409);
    const incomplete = await write('owner-write', `go-${randomUUID()}`, {
      ...requestBody, releases: requestBody.releases.filter(release =>
        release.version !== 'v1.3.0') });
    expect(incomplete.status).toBe(201);
    expect(await incomplete.json()).toMatchObject({ resolution: { outcome: {
      status: 'incomplete-source-data', buildList: [],
      missing: [{ path: 'example.com/c', version: 'v1.3.0' }] } } });
    const unsupported = await write('owner-write', `go-${randomUUID()}`, {
      ...requestBody, coverage: { complete: true,
        unsupportedClauses: ['replace example.com/a => ../local'] } });
    expect(unsupported.status).toBe(201);
    expect(await unsupported.json()).toMatchObject({ resolution: { outcome: {
      status: 'unsupported-semantics', buildList: [] } } });
    const directed = await write('owner-write', `go-${randomUUID()}`, {
      ...requestBody, profile: 'go-mvs-stable-unpruned-main-directives-v2',
      mainDirectives: { exclusions: [{ path: 'example.com/c', version: 'v1.2.0' }],
        replacements: [{ original: { path: 'example.com/c', version: 'v1.3.0' },
          source: { path: 'example.com/c', version: 'v1.9.0' } }] },
    });
    expect(directed.status).toBe(201);
    const directedBody = await directed.json() as { resolution: { profile: string;
      resolution: string; outcome: { status: string;
        selectedSources: Array<{ original: { path: string; version: string };
          source: { path: string; version: string } }> } } };
    expect(directedBody.resolution).toMatchObject({
      profile: 'go-mvs-stable-unpruned-main-directives-resolution-v2',
      outcome: { status: 'solved', selectedSources: [{
        original: { path: 'example.com/c', version: 'v1.3.0' },
        source: { path: 'example.com/c', version: 'v1.9.0' },
      }] } });
    expect((await read('owner-read', directedBody.resolution.resolution.split('/').at(-1)!)).status)
      .toBe(200);
    const wildcard = await write('owner-write', `go-${randomUUID()}`, {
      ...requestBody, profile: 'go-mvs-stable-unpruned-main-directives-v2',
      mainDirectives: { exclusions: [], replacements: [
        { original: { path: 'example.com/c' },
          source: { path: 'example.com/c', version: 'v1.9.0' } },
      ] },
    });
    expect(wildcard.status).toBe(201);
    const wildcardBody = await wildcard.json() as { resolution: { resolution: string;
      outcome: { status: string; selectedSources: unknown[] } } };
    expect(wildcardBody.resolution.outcome).toMatchObject({ status: 'solved',
      selectedSources: [{ original: { path: 'example.com/c', version: 'v1.3.0' },
        source: { path: 'example.com/c', version: 'v1.9.0' } }] });
    expect(await (await read('owner-read', wildcardBody.resolution.resolution.split('/').at(-1)!))
      .json()).toEqual(wildcardBody.resolution);
    const retracted = await write('owner-write', `go-${randomUUID()}`, {
      ...requestBody, profile: 'go-mvs-stable-unpruned-main-directives-v2',
      releases: requestBody.releases.map(release => release.path === 'example.com/c'
        && release.version === 'v1.9.0' ? { ...release, retractions: [
          { lower: 'v1.3.0', upper: 'v1.3.0', rationale: 'bad release' }] } : release),
      mainDirectives: { exclusions: [], replacements: [] },
    });
    expect(retracted.status).toBe(201);
    const retractedBody = await retracted.json() as { resolution: { resolution: string;
      outcome: { status: string; retractedSelected: unknown[] } } };
    expect(retractedBody.resolution.outcome).toMatchObject({ status: 'solved',
      retractedSelected: [{ selected: { path: 'example.com/c', version: 'v1.3.0' },
        announcedBy: { path: 'example.com/c', version: 'v1.9.0' },
        rationale: 'bad release' }] });
    expect(await (await read('owner-read', retractedBody.resolution.resolution.split('/').at(-1)!))
      .json()).toEqual(retractedBody.resolution);
    const pseudoVersion = 'v1.2.4-0.20260925020202-fedcba654321';
    const pseudo = await write('owner-write', `go-${randomUUID()}`, {
      ...requestBody, roots: [{ path: 'example.com/a', version: 'v1.0.0' }],
      releases: [
        { path: 'example.com/a', version: 'v1.0.0', requirements: [
          { path: 'example.com/c', version: pseudoVersion }] },
        { path: 'example.com/c', version: pseudoVersion, requirements: [] },
      ],
    });
    expect(pseudo.status).toBe(201);
    const pseudoBody = await pseudo.json() as { resolution: { resolution: string;
      outcome: { status: string; buildList: unknown[] } } };
    expect(pseudoBody.resolution.outcome).toMatchObject({ status: 'solved',
      buildList: [{ path: 'example.com/a', version: 'v1.0.0' },
        { path: 'example.com/c', version: pseudoVersion }] });
    expect(await (await read('owner-read', pseudoBody.resolution.resolution.split('/').at(-1)!))
      .json()).toEqual(pseudoBody.resolution);
    await expect(contentPool.query('UPDATE pkg.go_resolution SET request_digest = $2 WHERE id = $1',
      [id, '0'.repeat(64)])).rejects.toThrow();
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [ownerId]);
    expect((await write('owner-write', `go-${randomUUID()}`, requestBody)).status).toBe(403);
    expect((await read('owner-read', id)).status).toBe(403);
  } finally {
    await Promise.all([contentPool.end(), accessPool.end()]);
  }
});
