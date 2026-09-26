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
import { type IncludedGoSumdbLookup }
  from '../../../services/main/src/modules/package/go-sumdb-lookup.ts';
import { GoSumdbTrustStore }
  from '../../../services/main/src/modules/package/go-sumdb-trust.ts';
import includedFixture from '../fixtures/go-sumdb-x-sync.json';
import latestFixture from '../fixtures/go-sumdb-latest.json';

test('PKG05/PKG14/IAM10: Main Go verification scopes and active principal fence',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
      || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.FUSEKI_URL
      || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
      throw new Error('Run through the isolated QA integration tier');
    }
    const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
    const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
    const ownerId = randomUUID();
    const otherId = randomUUID();
    const issuer = 'https://qa-go-sumdb.test';
    const owner = { issuer, subject: randomUUID() };
    const other = { issuer, subject: randomUUID() };
    const proxy = (async (value: RequestInfo | URL) => {
      const url = String(value);
      if (url.endsWith('/@v/list')) return new Response('v0.1.0\n');
      if (url.endsWith('.info')) return new Response(JSON.stringify({
        Version: 'v0.1.0', Time: '2022-10-01T00:00:00Z' }));
      if (url.endsWith('.mod')) return new Response('module golang.org/x/sync\n');
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const captures = new GoProxyCaptureStore(pool, proxy);
    let lookups = 0;
    const trust = new GoSumdbTrustStore(pool, captures,
      (async () => { lookups++; return includedFixture as IncludedGoSumdbLookup; }) as
        ConstructorParameters<typeof GoSumdbTrustStore>[2],
      (async () => []) as ConstructorParameters<typeof GoSumdbTrustStore>[3],
      (async () => latestFixture) as ConstructorParameters<typeof GoSumdbTrustStore>[4]);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const app = createMainApp(fuseki, {
      environment: { fuseki,
        lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
          routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
        objectDirectory: '.temp/go-sumdb-unused' },
      account: { verify: async (request: Request, required: readonly string[]) => {
        const token = request.headers.get('authorization');
        if (token === 'Bearer owner-verify'
          && required[0] === 'package:verify') return owner;
        if (token === 'Bearer owner-read'
          && required[0] === 'package:read') return owner;
        if (token === 'Bearer other-verify'
          && required[0] === 'package:verify') return other;
        if (token === 'Bearer other-read'
          && required[0] === 'package:read') return other;
        throw new AccountAssertionDenied('package scope is unavailable');
      } },
      access: new AccessAdmissionRegistry(accessPool),
      packageCaptures: captures, packageVerifications: trust,
    });
    const write = (token: string, capture: string, key: string) =>
      app.handle(new Request(`http://main.local/v1/package-sources/go/${capture}/verify`,
        { method: 'POST', headers: { authorization: `Bearer ${token}`,
          'idempotency-key': key } }));
    const read = (token: string, verification: string) => app.handle(new Request(
      `http://main.local/v1/package-sources/go-verifications/${verification}`,
      { headers: { authorization: `Bearer ${token}` } }));
    try {
      await migrateContent(pool);
      await accessPool.query(`INSERT INTO access.principal
        (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
      [ownerId, issuer, owner.subject, otherId, other.subject]);
      const body = { profile: 'go-module-proxy-capture-v1' as const,
        path: 'golang.org/x/sync', version: 'v0.1.0' };
      const capture = (await captures.capture(ownerId,
        `go-sumdb-${randomUUID()}`, body)).capture.capture.split('/').at(-1)!;
      const otherCapture = (await captures.capture(ownerId,
        `go-sumdb-${randomUUID()}`, body)).capture.capture.split('/').at(-1)!;
      const key = `go-sumdb-${randomUUID()}`;
      expect((await write('owner-read', capture, key)).status).toBe(401);
      expect((await write('other-verify', capture, key)).status).toBe(404);
      expect(lookups).toBe(0);
      const created = await write('owner-verify', capture, key);
      expect(created.status).toBe(201);
      const result = await created.json() as { verification: {
        verification: string; includedTree: { size: number };
        trustedTree: { size: number } }; replayed: boolean };
      expect(result).toMatchObject({ replayed: false,
        verification: { includedTree: includedFixture.tree,
          trustedTree: latestFixture.tree } });
      const verification = result.verification.verification.split('/').at(-1)!;
      expect((await read('owner-verify', verification)).status).toBe(401);
      expect((await read('other-read', verification)).status).toBe(404);
      expect(await (await read('owner-read', verification)).json())
        .toEqual(result.verification);
      expect(await (await write('owner-verify', capture, key)).json())
        .toEqual({ ...result, replayed: true });
      expect(lookups).toBe(1);
      expect((await write('owner-verify', otherCapture, key)).status).toBe(409);
      await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1',
        [ownerId]);
      expect((await read('owner-read', verification)).status).toBe(403);
      expect((await write('owner-verify', capture,
        `go-sumdb-${randomUUID()}`)).status).toBe(403);
    } finally { await Promise.all([pool.end(), accessPool.end()]); }
  });
