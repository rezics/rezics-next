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
import { GoProxyCaptureStore }
  from '../../../services/main/src/modules/package/go-proxy-capture.ts';

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
    if (url.endsWith('/@v/list')) return new Response('v0.1.0\nv0.2.0-beta\n');
    if (url.endsWith('.info')) return new Response(JSON.stringify({
      Version: 'v0.1.0', Time: '2022-10-01T00:00:00Z' }));
    if (url.endsWith('.mod')) return new Response('module golang.org/x/sync\n\ngo 1.17\n');
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const app = createMainApp(fuseki, {
    environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
        routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp/go-proxy-unused' },
    account: { verify: async (request: Request, required: readonly string[]) => {
      const bearer = request.headers.get('authorization');
      if (bearer === 'Bearer owner-capture' && required[0] === 'package:capture') return owner;
      if (bearer === 'Bearer owner-read' && required[0] === 'package:read') return owner;
      if (bearer === 'Bearer other-read' && required[0] === 'package:read') return other;
      throw new AccountAssertionDenied('package scope is unavailable');
    } },
    access: new AccessAdmissionRegistry(accessPool),
    packageCaptures: new GoProxyCaptureStore(contentPool, fetcher),
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
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [ownerId]);
    expect((await read('owner-read', id)).status).toBe(403);
    expect((await write('owner-capture', `go-proxy-${randomUUID()}`, body)).status)
      .toBe(403);
  } finally {
    await Promise.all([contentPool.end(), accessPool.end()]);
  }
});
