import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied }
  from '../../../services/main/src/modules/account/verify-assertion.ts';
import { GoProxyCaptureStore }
  from '../../../services/main/src/modules/package/go-proxy-capture.ts';
import { GoMvsResolutionStore }
  from '../../../services/main/src/modules/package/go-mvs.ts';

test('PKG05/PKG20/IAM10: Go proxy capture is bounded, private, immutable and replayable', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const issuer = 'https://qa-go-proxy.test';
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const seen: string[] = [];
  const fetcher = (async (value: RequestInfo | URL) => {
    const url = String(value);
    seen.push(url);
    if (url.includes('/example.com/')) {
      const modulePath = url.includes('/example.com/a/') ? 'example.com/a' : 'example.com/b';
      if (url.endsWith('/@v/list')) return new Response('v1.0.0\n');
      if (url.endsWith('.info')) return new Response(JSON.stringify({
        Version: 'v1.0.0', Time: '2022-10-01T00:00:00Z' }));
      if (url.endsWith('.mod')) return new Response(`module ${modulePath}\n\ngo 1.16\n${
        modulePath === 'example.com/a' ? 'require example.com/b v1.0.0\n' : ''}`);
    }
    if (url.endsWith('/@v/list')) return new Response('v0.1.0\nv0.2.0-beta\n');
    if (url.endsWith('.info')) return new Response(JSON.stringify({
      Version: 'v0.1.0', Time: '2022-10-01T00:00:00Z' }));
    if (url.endsWith('.mod')) return new Response('module golang.org/x/sync\n\ngo 1.17\n');
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const captureStore = new GoProxyCaptureStore(contentPool, fetcher);
  const app = createMainApp(fuseki, {
    environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
        routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp/go-proxy-unused' },
    account: { verify: async (request: Request, required: readonly string[]) => {
      const bearer = request.headers.get('authorization');
      if (bearer === 'Bearer owner-capture' && required[0] === 'package:capture') return owner;
      if (bearer === 'Bearer owner-read' && required[0] === 'package:read') return owner;
      if (bearer === 'Bearer owner-resolve' && required[0] === 'package:resolve') return owner;
      if (bearer === 'Bearer other-read' && required[0] === 'package:read') return other;
      if (bearer === 'Bearer other-resolve' && required[0] === 'package:resolve') return other;
      throw new AccountAssertionDenied('package scope is unavailable');
    } },
    access: new AccessAdmissionRegistry(accessPool),
    packageCaptures: captureStore,
    packageResolutions: new GoMvsResolutionStore(contentPool, captureStore),
  });
  const body = { profile: 'go-module-proxy-capture-v1',
    path: 'golang.org/x/sync', version: 'v0.1.0' };
  const write = (token: string, key: string, requestBody: object) => app.handle(new Request(
    'http://main.local/v1/package-sources/go', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify(requestBody) }));
  const read = (token: string, id: string) => app.handle(new Request(
    `http://main.local/v1/package-sources/go/${id}`,
    { headers: { authorization: `Bearer ${token}` } }));
  const resolve = (token: string, key: string, requestBody: object) => app.handle(new Request(
    'http://main.local/v1/package-resolutions/from-captures', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify(requestBody) }));
  try {
    await migrateContent(contentPool);
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
    [ownerId, issuer, owner.subject, otherId, other.subject]);
    const key = `go-proxy-${randomUUID()}`;
    expect((await write('owner-read', key, body)).status).toBe(401);
    expect(seen).toHaveLength(0);
    const created = await write('owner-capture', key, body);
    expect(created.status).toBe(201);
    const saved = await created.json() as { capture: { capture: string;
      versionList: { stableVersions: string[]; omittedTagCount: number };
      manifest: { text: string; rawSha256: string } }; replayed: boolean };
    expect(saved.replayed).toBe(false);
    expect(saved.capture).toMatchObject({ provider: 'proxy.golang.org',
      versionList: { stableVersions: ['v0.1.0'], omittedTagCount: 1 },
      manifest: { text: 'module golang.org/x/sync\n\ngo 1.17\n',
        goModH1: expect.stringMatching(/^h1:[A-Za-z0-9+/]{43}=$/),
        parsed: { status: 'parsed', declaredModule: 'golang.org/x/sync',
          goDirective: '1.17', requirements: [],
          compatibleWithUnprunedGo116: false } } });
    expect(saved.capture.manifest.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(seen).toHaveLength(3);
    const id = saved.capture.capture.split('/').at(-1)!;
    expect((await read('owner-capture', id)).status).toBe(401);
    expect(await (await read('owner-read', id)).json()).toEqual(saved.capture);
    expect((await read('other-read', id)).status).toBe(404);
    expect(await (await write('owner-capture', key, body)).json())
      .toEqual({ capture: saved.capture, replayed: true });
    expect(seen).toHaveLength(3);
    expect((await write('owner-capture', key, { ...body, version: 'v0.2.0' })).status)
      .toBe(409);
    expect(seen).toHaveLength(3);
    await expect(contentPool.query('UPDATE pkg.go_proxy_capture SET module_version = $2 WHERE id = $1',
      [id, 'v0.2.0'])).rejects.toThrow();
    const sourceIds: string[] = [];
    for (const path of ['example.com/a', 'example.com/b']) {
      const captured = await write('owner-capture', `go-proxy-${randomUUID()}`, {
        profile: 'go-module-proxy-capture-v1', path, version: 'v1.0.0' });
      expect(captured.status).toBe(201);
      sourceIds.push((await captured.json() as { capture: { capture: string } })
        .capture.capture.split('/').at(-1)!);
    }
    const derivedBody = { profile: 'go-mvs-from-captures-v1',
      mainModule: 'example.com/main',
      roots: [{ path: 'example.com/a', version: 'v1.0.0' }], captures: sourceIds };
    const resolutionKey = `go-derived-${randomUUID()}`;
    expect((await resolve('owner-read', resolutionKey, derivedBody)).status).toBe(401);
    expect((await resolve('other-resolve', `go-derived-${randomUUID()}`,
      derivedBody)).status).toBe(404);
    const resolved = await resolve('owner-resolve', resolutionKey, derivedBody);
    expect(resolved.status).toBe(201);
    const resolvedBody = await resolved.json() as { resolution: { resolution: string;
      request: { captureEvidence: unknown[] };
      outcome: { status: string; buildList: unknown[] } }; replayed: boolean };
    expect(resolvedBody.resolution).toMatchObject({
      profile: 'go-mvs-captured-unpruned-resolution-v3',
      request: { profile: 'go-mvs-captured-unpruned-v3',
        captureEvidence: [{ captureId: sourceIds[0] }, { captureId: sourceIds[1] }] },
      outcome: { status: 'solved', buildList: [
        { path: 'example.com/a', version: 'v1.0.0' },
        { path: 'example.com/b', version: 'v1.0.0' }] } });
    const resolutionId = resolvedBody.resolution.resolution.split('/').at(-1)!;
    const resolutionRead = await app.handle(new Request(
      `http://main.local/v1/package-resolutions/${resolutionId}`,
      { headers: { authorization: 'Bearer owner-read' } }));
    expect(resolutionRead.status).toBe(200);
    expect(await resolutionRead.json()).toEqual(resolvedBody.resolution);
    expect((await app.handle(new Request(
      `http://main.local/v1/package-resolutions/${resolutionId}`,
      { headers: { authorization: 'Bearer other-read' } }))).status).toBe(404);
    expect(await (await resolve('owner-resolve', resolutionKey, derivedBody)).json())
      .toEqual({ ...resolvedBody, replayed: true });
    expect((await resolve('owner-resolve', resolutionKey,
      { ...derivedBody, captures: [sourceIds[0]] })).status).toBe(409);
    const incomplete = await resolve('owner-resolve', `go-derived-${randomUUID()}`,
      { ...derivedBody, captures: [sourceIds[0]] });
    expect(incomplete.status).toBe(201);
    expect(await incomplete.json()).toMatchObject({ resolution: { outcome: {
      status: 'incomplete-source-data', buildList: [],
      missing: [{ path: 'example.com/b', version: 'v1.0.0' }] } } });
    const unsupported = await resolve('owner-resolve', `go-derived-${randomUUID()}`,
      { ...derivedBody, roots: [{ path: 'golang.org/x/sync', version: 'v0.1.0' }],
        captures: [id] });
    expect(unsupported.status).toBe(201);
    expect(await unsupported.json()).toMatchObject({ resolution: { outcome: {
      status: 'unsupported-semantics', buildList: [] } } });
    const mainText = 'module example.com/main\n\ngo 1.16\n\nrequire example.com/a v1.0.0\n';
    const manifestBody = { profile: 'go-mvs-from-main-captures-v2',
      mainManifestBase64: Buffer.from(mainText).toString('base64'),
      captures: sourceIds };
    const manifestKey = `go-main-derived-${randomUUID()}`;
    expect((await resolve('other-resolve', `go-main-derived-${randomUUID()}`,
      manifestBody)).status).toBe(404);
    const mainResolved = await resolve('owner-resolve', manifestKey, manifestBody);
    expect(mainResolved.status).toBe(201);
    const mainResolution = await mainResolved.json() as { resolution: {
      resolution: string; request: { roots: unknown[];
        mainManifest: { text: string; rawSha256: string } }; outcome: unknown };
      replayed: boolean };
    expect(mainResolution.resolution.request).toMatchObject({
      roots: [{ path: 'example.com/a', version: 'v1.0.0' }],
      mainManifest: { text: mainText,
        rawSha256: createHash('sha256').update(mainText).digest('hex') } });
    expect(mainResolution.resolution.outcome).toMatchObject({ status: 'solved',
      buildList: [{ path: 'example.com/a', version: 'v1.0.0' },
        { path: 'example.com/b', version: 'v1.0.0' }] });
    const mainId = mainResolution.resolution.resolution.split('/').at(-1)!;
    expect(await (await app.handle(new Request(
      `http://main.local/v1/package-resolutions/${mainId}`,
      { headers: { authorization: 'Bearer owner-read' } }))).json())
      .toEqual(mainResolution.resolution);
    expect(await (await resolve('owner-resolve', manifestKey, manifestBody)).json())
      .toEqual({ ...mainResolution, replayed: true });
    expect((await resolve('owner-resolve', manifestKey,
      { ...manifestBody, mainManifestBase64: Buffer.from(mainText.replace('v1.0.0',
        'v1.0.1')).toString('base64') })).status).toBe(409);
    expect((await resolve('owner-resolve', `go-main-derived-${randomUUID()}`,
      { ...manifestBody, mainManifestBase64: '***' })).status).toBe(422);
    const unsupportedMain = await resolve('owner-resolve',
      `go-main-derived-${randomUUID()}`, { ...manifestBody,
        mainManifestBase64: Buffer.from(`${mainText}replace example.com/a v1.0.0 => example.com/b v1.0.0\n`)
          .toString('base64') });
    expect(unsupportedMain.status).toBe(201);
    expect(await unsupportedMain.json()).toMatchObject({ resolution: { outcome: {
      status: 'unsupported-semantics', buildList: [],
      unsupportedClauses: [expect.stringContaining('replace')] } } });
    const incompatibleMain = await resolve('owner-resolve',
      `go-main-derived-${randomUUID()}`, { ...manifestBody,
        mainManifestBase64: Buffer.from(mainText.replace('go 1.16', 'go 1.17'))
          .toString('base64') });
    expect(incompatibleMain.status).toBe(201);
    expect(await incompatibleMain.json()).toMatchObject({ resolution: { outcome: {
      status: 'unsupported-semantics', buildList: [],
      unsupportedClauses: [expect.stringContaining('go directive 1.17')] } } });
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [ownerId]);
    expect((await read('owner-read', id)).status).toBe(403);
    expect((await write('owner-capture', `go-proxy-${randomUUID()}`, body)).status)
      .toBe(403);
    expect((await resolve('owner-resolve', `go-derived-${randomUUID()}`,
      derivedBody)).status).toBe(403);
  } finally {
    await Promise.all([contentPool.end(), accessPool.end()]);
  }
});
