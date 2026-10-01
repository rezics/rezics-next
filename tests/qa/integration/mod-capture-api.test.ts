import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ModResolutionStore } from '../../../services/main/src/modules/package/mod-resolution.ts';
import type { ModCapture, ModRequest } from '../../../services/main/src/modules/package/mod-profile.ts';
import { fixtureJar } from '../fixtures/mod-native-oracle/zip.ts';
import { curseForgeAuthored, curseForgeRelations, steamCollectionAuthored,
  steamRequiredItemsAuthored } from '../fixtures/mod-provider-authored.ts';
import { acquireLiveModProviders } from '../fixtures/mod-provider-live.ts';

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
function capture(identity: string, surface: string, value: unknown): ModCapture {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { identity, surface, status: 'observed', bytesBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
function archiveCapture(parent: ModCapture, child: ModCapture): ModCapture {
  const bytes = fixtureJar([
    ['fabric.mod.json', Buffer.from(parent.bytesBase64!, 'base64')],
    ['META-INF/jars/child.jar', fixtureJar([
      ['fabric.mod.json', Buffer.from(child.bytesBase64!, 'base64')],
    ])],
  ]);
  return { identity: parent.identity, surface: 'archive', status: 'observed',
    bytesBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
function modRequest(ecosystem: ModRequest['ecosystem'], root: string,
  captures: ModCapture[]): ModRequest {
  return { profile: 'mod-native-capture-v1', ecosystem, side: 'CLIENT', root, captures,
    ...(ecosystem === 'forge' || ecosystem === 'neoforge'
      ? { runtime: { loaderVersion: '52', gameVersion: '1.21.1' } } : {}) };
}

test('PKG07/PKG08/PKG09/PKG10/PKG11/IAM10: real Account, Access, Main and Content protect mod capture receipts', async () => {
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
      const email = `mod-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    await accountPool.query("INSERT INTO rezics_account_operator (user_id, role) VALUES ($1, 'owner') ON CONFLICT DO NOTHING", [operator.id]);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders, body: {
      client_name: 'Mod Main verifier', scope: 'package:resolve',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['package:resolve'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const client = await auth.api.adminCreateOAuthClient({ headers: adminHeaders, body: {
      client_name: 'Mod API client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      scope: 'openid package:resolve package:read',
      skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const other = await signUp('other');
    const principalId = randomUUID();
    const otherId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
    [principalId, `${base}/api/auth`, member.id, otherId, other.id]);
    const tokenFor = async (person: typeof member, scope: string) => {
      const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: person.email, password: person.password }),
      });
      expect(signIn.status).toBe(200);
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: client.client_id, redirect_uri: redirectUri, scope,
        state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, { headers: { cookie: signIn.headers.get('set-cookie')! },
        redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchanged = await fetch(`${base}/api/auth/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: client.client_id, code, redirect_uri: redirectUri,
          code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }),
      });
      expect(exchanged.status).toBe(200);
      return (await exchanged.json() as { access_token: string }).access_token;
    };
    const resolveToken = await tokenFor(member, 'openid package:resolve');
    const readToken = await tokenFor(member, 'openid package:read');
    const otherReadToken = await tokenFor(other, 'openid package:read');
    await migrateContent(contentPool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const app = createMainApp(fuseki, {
      environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
        routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: '.temp/mod-unused' },
      account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
        audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
        introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
      access: new AccessAdmissionRegistry(accessPool),
      packageModResolutions: new ModResolutionStore(contentPool),
    });
    const write = (token: string, key: string, body: ModRequest) => app.handle(new Request(
      'http://main.local/v1/package-resolutions/mods', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
    const read = (token: string, id: string) => app.handle(new Request(
      `http://main.local/v1/package-resolutions/mods/${id}`,
      { headers: { authorization: `Bearer ${token}` } }));
    const live = await acquireLiveModProviders();
    const semantic = (item: ModCapture): ModCapture => ({ identity: item.identity,
      surface: item.surface, status: item.status, bytesBase64: item.bytesBase64,
      sha256: item.sha256, sourceUrl: item.sourceUrl, httpStatus: item.httpStatus });
    const nestedParent = capture('parent', 'manifest', { schemaVersion: 1, id: 'parent',
      version: '1.0.0', jars: [{ file: 'META-INF/jars/child.jar' }],
      depends: { child: '*' } });
    const nestedChild = { ...capture('child', 'manifest', { schemaVersion: 1, id: 'child',
      version: '1.0.0' }), nestedOf: 'parent', nestedPath: 'META-INF/jars/child.jar' };
    const cases: Array<{ id: string; request: ModRequest; selection: string }> = [
      { id: 'PKG07', request: modRequest('fabric', 'root', [
        capture('root', 'manifest', { schemaVersion: 1, id: 'root', version: '1.0.0',
          breaks: { peer: '*' } }),
        capture('peer', 'manifest', { schemaVersion: 1, id: 'peer', version: '1.0.0' })]),
        selection: 'unsatisfiable' },
      { id: 'PKG07-nested', request: modRequest('fabric', 'parent', [
        nestedParent, nestedChild, archiveCapture(nestedParent, nestedChild)]), selection: 'valid' },
      { id: 'PKG08', request: modRequest('forge', 'root', [
        capture('root', 'manifest', 'modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\n[[mods]]\nmodId="root"\nversion="1.0.0"')]),
        selection: 'valid' },
      { id: 'PKG08-neo-mixin', request: { ...modRequest('neoforge', 'root', [
        capture('root', 'manifest', 'modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n[[mods]]\nmodId="root"\nversion="1.0.0"\n[features.root]\nopenGLVersion="[3.2,)"\n[[mixins]]\nconfig="root.mixins.json"\nrequiredMods=["other"]')]),
        runtime: { loaderVersion: '4', gameVersion: '1.21.1',
          features: { openGLVersion: '3.2' } } }, selection: 'valid' },
      { id: 'PKG09', request: modRequest('modrinth', 'p3OA9KJx',
        live.captures.modrinth.map(semantic)), selection: 'valid' },
      { id: 'PKG09-curseforge-authored', request: curseForgeAuthored, selection: 'valid' },
      { id: 'PKG10', request: modRequest('nexus', '1', live.captures.nexus.map(semantic)),
        selection: 'incomplete-source-data' },
      { id: 'PKG11-soft-authored', request: steamRequiredItemsAuthored, selection: 'valid' },
      { id: 'PKG11-collection-authored', request: steamCollectionAuthored, selection: 'valid' },
      { id: 'PKG11-collection', request: modRequest('steam', '1175117161',
        live.captures.steamCollection.map(semantic)), selection: 'valid' },
      { id: 'PKG11-soft-gap', request: modRequest('steam', '2370295313',
        live.captures.steamItem.map(semantic)), selection: 'incomplete-source-data' },
    ];
    const first = cases[0]!;
    const key = `mod-${randomUUID()}`;
    expect((await write(readToken, key, first.request)).status).toBe(401);
    const [created, raced] = await Promise.all([
      write(resolveToken, key, first.request), write(resolveToken, key, first.request)]);
    expect([created.status, raced.status].sort()).toEqual([200, 201]);
    const receipt = (await created.json() as { resolution: { resolution: string;
      outcome: { selection: string } }; replayed: boolean }).resolution;
    const id = receipt.resolution.split('/').at(-1)!;
    expect((await read(readToken, id)).status).toBe(200);
    expect((await read(otherReadToken, id)).status).toBe(404);
    expect((await write(resolveToken, key, cases[1]!.request)).status).toBe(409);
    for (const entry of cases.slice(1)) {
      const entryKey = `mod-${entry.id}-${randomUUID()}`;
      const response = await write(resolveToken, entryKey, entry.request);
      expect(response.status).toBe(201);
      const result = await response.json() as { resolution: { outcome: { selection: string } } };
      expect(result.resolution.outcome.selection).toBe(entry.selection);
      if (entry.id.endsWith('-authored')) {
        const stored = result.resolution as unknown as { resolution: string;
          profile: string; request: ModRequest; outcome: unknown };
        expect(stored.profile).toBe(entry.request.profile === 'mod-native-capture-v2'
          ? 'mod-native-capture-receipt-v2' : 'mod-native-capture-receipt-v1');
        const storedId = stored.resolution.split('/').at(-1)!;
        const reread = await read(readToken, storedId);
        expect(reread.status).toBe(200);
        expect(await reread.json()).toEqual(result.resolution);
        expect((await read(otherReadToken, storedId)).status).toBe(404);
        const replay = await write(resolveToken, entryKey, entry.request);
        expect(replay.status).toBe(200);
        expect((await replay.json() as { resolution: { resolution: string } })
          .resolution.resolution).toBe(stored.resolution);
        expect(stored.request).toEqual(entry.request);
      }
      if (entry.id === 'PKG09') {
        const retained = result.resolution as unknown as { request: ModRequest };
        const retainedRoot = JSON.parse(Buffer.from(
          retained.request.captures[0]!.bytesBase64!, 'base64').toString('utf8')) as {
          dependencies: Array<{ version_id: string | null; project_id: string | null }> };
        expect(retainedRoot.dependencies.some(dep => dep.version_id === live.embedded.version_id
          && dep.project_id === live.embedded.project_id)).toBe(true);
        const outcome = result.resolution.outcome as { relations: Array<{ to: string; kind: string;
          strength: string }>; independentDownloads: string[]; coverage: Array<{ status: string }> };
        expect(outcome.relations.some(edge => edge.to === live.embedded.version_id
          && edge.kind === 'embedded' && edge.strength === 'embedded')).toBe(true);
        expect(outcome.independentDownloads).not.toContain(live.embedded.version_id);
        expect(outcome.coverage.map(item => item.status)).toEqual(['observed', 'observed']);
      }
      if (entry.id === 'PKG10') {
        const outcome = result.resolution.outcome as { relations: unknown[];
          coverage: Array<{ surface: string; status: string; httpStatus?: number }> };
        expect(outcome.relations).toEqual([]);
        expect(outcome.coverage.map(item => [item.surface, item.status]))
          .toEqual([['graphql-public', 'observed'], ['file-version-range', 'inaccessible']]);
      }
      if (entry.id === 'PKG09-curseforge-authored') {
        const stored = result.resolution as unknown as { request: ModRequest;
          outcome: { relations: Array<{ from: string; to: string; kind: string;
            strength: string }>; independentDownloads: string[] } };
        const file = JSON.parse(Buffer.from(stored.request.captures[0]!.bytesBase64!,
          'base64').toString('utf8')) as { data: { dependencies: unknown[] } };
        expect(file.data.dependencies).toEqual(curseForgeRelations);
        expect(stored.outcome.relations.map(edge => [edge.from, edge.to, edge.kind,
          edge.strength])).toEqual([
          ['101', '20', 'embedded', 'embedded'],
          ['101', '25', 'optional', 'advisory'],
          ['101', '30', 'required', 'hard'],
          ['101', '40', 'tool', 'metadata'],
          ['101', '50', 'incompatible', 'hard'],
          ['101', '60', 'include', 'embedded'],
        ]);
        expect(stored.outcome.independentDownloads).toEqual(['101', '301']);
      }
      if (entry.id === 'PKG11-soft-authored' || entry.id === 'PKG11-collection-authored') {
        const outcome = result.resolution.outcome as { relations: Array<{ kind: string;
          strength: string }>; independentDownloads: string[] };
        expect(outcome.relations).toHaveLength(2);
        expect(outcome.relations.every(edge => entry.id === 'PKG11-soft-authored'
          ? edge.kind === 'soft-dependency' && edge.strength === 'advisory'
          : edge.kind === 'collection-member' && edge.strength === 'collection')).toBe(true);
        expect(outcome.independentDownloads).toEqual(entry.id === 'PKG11-soft-authored'
          ? ['987654321'] : ['888888888']);
      }
      if (entry.id === 'PKG11-collection') {
        const outcome = result.resolution.outcome as { relations: Array<{ kind: string;
          strength: string }>; cost: { comparisons: number } };
        expect(outcome.relations.length).toBeGreaterThan(0);
        expect(outcome.relations.every(edge => edge.kind === 'collection-member'
          && edge.strength === 'collection')).toBe(true);
        expect(outcome.cost.comparisons).toBe(0);
      }
      if (entry.id === 'PKG11-soft-gap') {
        const outcome = result.resolution.outcome as { relations: unknown[] };
        expect(outcome.relations).toEqual([]);
      }
    }
    const bad = { ...first.request, captures: [{ ...first.request.captures[0]!, sha256: '0'.repeat(64) }] };
    const beforeBad = Number((await contentPool.query('SELECT count(*) FROM pkg.mod_resolution')).rows[0].count);
    expect((await write(resolveToken, `mod-bad-${randomUUID()}`, bad)).status).toBe(422);
    expect(Number((await contentPool.query('SELECT count(*) FROM pkg.mod_resolution')).rows[0].count))
      .toBe(beforeBad);
    await contentPool.query(`INSERT INTO pkg.mod_resolution
      (id, principal_id, idempotency_key, request_digest, request, outcome)
      SELECT gen_random_uuid(), $2, 'mod-bulk-' || gs.n, request_digest, request, outcome
      FROM pkg.mod_resolution, generate_series(1, 4096) AS gs(n) WHERE id = $1`,
    [id, otherId]);
    const explained = await contentPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM pkg.mod_resolution WHERE id = $1 AND principal_id = $2`,
    [id, principalId]);
    const plan = explained.rows[0]['QUERY PLAN'][0].Plan as {
      'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number };
    expect(plan['Actual Rows']).toBe(1);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(40);
    await expect(contentPool.query(`UPDATE pkg.mod_resolution
      SET outcome = outcome WHERE id = $1`, [id])).rejects.toThrow();
    await contentPool.query('ALTER TABLE pkg.mod_resolution DISABLE TRIGGER pkg_mod_resolution_immutable');
    try {
      await contentPool.query(`UPDATE pkg.mod_resolution SET outcome = jsonb_set(outcome,
        '{selection}', '"valid"') WHERE id = $1`, [id]);
      expect((await read(readToken, id)).status).toBe(503);
      await contentPool.query('UPDATE pkg.mod_resolution SET outcome = $2 WHERE id = $1',
        [id, JSON.stringify(receipt.outcome)]);
      expect((await read(readToken, id)).status).toBe(200);
    } finally {
      await contentPool.query('ALTER TABLE pkg.mod_resolution ENABLE TRIGGER pkg_mod_resolution_immutable');
    }
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalId]);
    expect((await read(readToken, id)).status).toBe(403);
    expect((await write(resolveToken, `mod-stale-${randomUUID()}`, first.request)).status).toBe(403);
  } finally {
    await server.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
  }
}, 30_000);
