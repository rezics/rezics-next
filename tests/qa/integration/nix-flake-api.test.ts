import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { NixResolutionStore } from '../../../services/main/src/modules/package/nix-resolution.ts';
import type { NixRequest } from '../../../services/main/src/modules/package/nix-graph.ts';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function fixtureRequest(): Promise<NixRequest> {
  const fixture = resolve('tests/qa/fixtures/nix-flake');
  return { profile: 'nix-flake-native-v1', system: 'x86_64-linux', package: 'default',
    flakeNix: await readFile(resolve(fixture, 'flake.nix'), 'utf8'),
    flakeLock: await readFile(resolve(fixture, 'flake.lock'), 'utf8'),
    files: [{ path: 'base/source.txt', text: await readFile(resolve(fixture, 'base/source.txt'), 'utf8') }],
    runtime: 'observe' };
}

test('PKG06/IAM10: native Nix receipts cross real Account, Access, Main and Content with private replay',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
      || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_DATABASE_URL
      || !Bun.env.ACCOUNT_MAIN_RESOURCE || !Bun.env.FUSEKI_URL
      || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
      throw new Error('Run through the isolated QA integration tier');
    }
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
    const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const operators = new Set<string>();
    const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
    const server = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
    try {
      const signUp = async (name: string) => {
        const response = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST',
          headers: { 'content-type': 'application/json', origin: base },
          body: JSON.stringify({ name, email: `nix-${name}-${randomUUID()}@example.test`,
            password: randomBytes(24).toString('base64url') }) });
        expect(response.status).toBe(200);
        return { id: (await response.json() as { user: { id: string } }).user.id,
          cookie: response.headers.get('set-cookie')! };
      };
      const operator = await signUp('operator');
      operators.add(operator.id);
      const headers = new Headers({ cookie: operator.cookie, origin: base });
      const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
        client_name: 'Nix Main verifier', scope: 'package:read',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['package:read'] } });
      const redirectUri = 'http://localhost:3000/auth/callback';
      const client = await auth.api.adminCreateOAuthClient({ headers, body: {
        client_name: 'Nix flake client', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid package:resolve package:read',
        skip_consent: true, require_pkce: true } });
      const owner = await signUp('owner');
      const other = await signUp('other');
      const ownerId = randomUUID();
      const otherId = randomUUID();
      await accessPool.query(`INSERT INTO access.principal
        (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
      [ownerId, `${base}/api/auth`, owner.id, otherId, other.id]);
      const tokenFor = async (scope: string, cookie: string) => {
        const verifier = randomBytes(32).toString('base64url');
        const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
        for (const [key, value] of Object.entries({ response_type: 'code',
          client_id: client.client_id, redirect_uri: redirectUri, scope: `openid ${scope}`,
          state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
        const authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
        expect(authorized.status).toBe(302);
        const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
        const exchanged = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code',
            client_id: client.client_id, code, redirect_uri: redirectUri,
            code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }) });
        expect(exchanged.status).toBe(200);
        return (await exchanged.json() as { access_token: string }).access_token;
      };
      const tokens = { write: await tokenFor('package:resolve', owner.cookie),
        read: await tokenFor('package:read', owner.cookie),
        otherRead: await tokenFor('package:read', other.cookie) };
      await migrateContent(contentPool);
      const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
      const app = createMainApp(fuseki, {
        environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
          routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: '.temp/nix-api-unused' },
        account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
          audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
          introspectUrl: `${base}/api/auth/oauth2/introspect`,
          clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
        access: new AccessAdmissionRegistry(accessPool),
        packageNixResolutions: new NixResolutionStore(contentPool),
      });
      const write = (token: string, key: string, body: object) => app.handle(new Request(
        'http://main.local/v1/package-resolutions/nix', { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            'idempotency-key': key }, body: JSON.stringify(body) }));
      const read = (token: string, id: string) => app.handle(new Request(
        `http://main.local/v1/package-resolutions/nix/${id}`,
        { headers: { authorization: `Bearer ${token}` } }));
      const request = await fixtureRequest();
      const key = `nix-${randomUUID()}`;
      expect((await write(tokens.read, key, request)).status).toBe(401);
      const [first, second] = await Promise.all([
        write(tokens.write, key, request), write(tokens.write, key, request) ]);
      expect([first.status, second.status].sort()).toEqual([200, 201]);
      const firstBody = await first.json() as { replayed: boolean; resolution: {
        resolution: string; outcome: { status: string; inputGraph: { edges: unknown[] };
          derivationGraph: { edges: unknown[] }; runtimeClosure: { paths: unknown[] } } } };
      const secondBody = await second.json() as typeof firstBody;
      expect(firstBody.resolution).toEqual(secondBody.resolution);
      expect(firstBody.resolution.outcome).toMatchObject({ status: 'observed',
        inputGraph: { edges: [{ from: 'root', name: 'alias', to: ['base'] },
          { from: 'root', name: 'base', to: 'base' }] } });
      expect(firstBody.resolution.outcome.derivationGraph.edges).toHaveLength(1);
      expect(firstBody.resolution.outcome.runtimeClosure.paths).toHaveLength(1);
      const id = firstBody.resolution.resolution.split('/').at(-1)!;
      expect((await read(tokens.write, id)).status).toBe(401);
      expect((await read(tokens.otherRead, id)).status).toBe(404);
      expect(await (await read(tokens.read, id)).json()).toEqual(firstBody.resolution);
      expect((await write(tokens.write, key, { ...request, runtime: 'unobserved' })).status).toBe(409);
      const replay = await write(tokens.write, key, request);
      expect(replay.status).toBe(200);
      expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
      const count = await contentPool.query<{ count: string }>(
        'SELECT count(*) FROM pkg.nix_resolution WHERE principal_id = $1', [ownerId]);
      expect(Number(count.rows[0]!.count)).toBe(1);
      // A lost response after the immutable insert recovers by key without another Nix run.
      const savedOutcome = (await new NixResolutionStore(contentPool).read(ownerId, id))!.outcome;
      let inserted = false;
      const interruptedPool = new Proxy(contentPool, { get(target, property, receiver) {
        if (property === 'query') return (sql: string, values?: unknown[]) => {
          if (inserted && sql.includes('SELECT * FROM pkg.nix_resolution')) {
            inserted = false;
            throw new Error('injected post-insert read loss');
          }
          if (sql.includes('INSERT INTO pkg.nix_resolution')) inserted = true;
          return target.query(sql, values);
        };
        return Reflect.get(target, property, receiver);
      } }) as Pool;
      const recoveryKey = `nix-recovery-${randomUUID()}`;
      await expect(new NixResolutionStore(interruptedPool,
        async () => savedOutcome).resolve(ownerId, recoveryKey, request)).rejects.toThrow(
        'injected post-insert read loss');
      const recovery = await new NixResolutionStore(contentPool, async () => {
        throw new Error('replay must not evaluate');
      }).resolve(ownerId, recoveryKey, request);
      expect(recovery.replayed).toBe(true);
      expect(recovery.resolution.outcome).toEqual(savedOutcome);
      // PKG06 cost: unrelated immutable receipts grow 64 -> 512 -> 4096.
      // The indexed exact read must still examine at most one owner row and a bounded page set.
      let priorScale = 0;
      for (const scale of [64, 512, 4_096]) {
        await contentPool.query(`INSERT INTO pkg.nix_resolution
          (id, principal_id, idempotency_key, request_digest, outcome_digest, request, outcome)
          SELECT gen_random_uuid(), $1, 'noise-' || g::text,
            original.request_digest, original.outcome_digest, original.request, original.outcome
          FROM pkg.nix_resolution original, generate_series($3::int, $4::int) AS g
          WHERE original.id = $2`, [otherId, id, priorScale + 1, scale]);
        priorScale = scale;
        const explained = await contentPool.query<{ 'QUERY PLAN': Array<{ Plan: {
          'Actual Rows': number; 'Rows Removed by Filter'?: number;
          'Shared Hit Blocks'?: number; Plans?: unknown[] } }> }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
           SELECT * FROM pkg.nix_resolution WHERE id = $1 AND principal_id = $2`,
        [id, ownerId]);
        const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
        expect(plan['Actual Rows']).toBe(1);
        if (scale >= 512) {
          expect(plan['Rows Removed by Filter'] ?? 0).toBeLessThanOrEqual(1);
          expect(plan['Shared Hit Blocks'] ?? 0).toBeLessThanOrEqual(64);
        }
      }
      await expect(contentPool.query('UPDATE pkg.nix_resolution SET outcome = $1 WHERE id = $2',
        ['{}', id])).rejects.toThrow();
      const recovered = new NixResolutionStore(contentPool);
      expect(await recovered.read(ownerId, id)).toEqual(firstBody.resolution);
      const stale = await write(tokens.write, `nix-${randomUUID()}`, { ...request,
        flakeNix: request.flakeNix.replace('path:./base', 'path:./other'),
        files: [...request.files, { path: 'other/source.txt', text: 'other\n' }] });
      expect(stale.status).toBe(201);
      expect(await stale.json()).toMatchObject({ resolution: { outcome: {
        status: 'evaluation-failed', failure: 'stale-lock', derivationGraph: null,
        runtimeClosure: { status: 'unobserved' } } } });
      const changedSource = await write(tokens.write, `nix-${randomUUID()}`, { ...request,
        files: [{ path: 'base/source.txt', text: 'tampered source\n' }] });
      expect(changedSource.status).toBe(201);
      expect(await changedSource.json()).toMatchObject({ resolution: { outcome: {
        status: 'evaluation-failed', failure: 'source-hash-mismatch', derivationGraph: null,
        runtimeClosure: { status: 'unobserved' } } } });
      await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [ownerId]);
      expect((await read(tokens.read, id)).status).toBe(403);
      expect((await write(tokens.write, key, request)).status).toBe(403);
    } finally {
      await server.stop();
      await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
    }
  }, 120_000);
