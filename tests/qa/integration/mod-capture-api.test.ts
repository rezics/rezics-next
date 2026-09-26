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
function modRequest(ecosystem: ModRequest['ecosystem'], root: string,
  captures: ModCapture[]): ModRequest {
  return { profile: 'mod-native-capture-v1', ecosystem, side: 'CLIENT', root, captures,
    ...(ecosystem === 'forge' || ecosystem === 'neoforge'
      ? { runtime: { loaderVersion: '52', gameVersion: '1.21.1' } } : {}) };
}

test('PKG07-PKG11/IAM10: real Account, Access, Main and Content protect mod capture receipts', async () => {
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
        body: JSON.stringify({ name, email, password }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
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
    const cases: Array<{ id: string; request: ModRequest; selection: string }> = [
      { id: 'PKG07', request: modRequest('fabric', 'root', [
        capture('root', 'manifest', { schemaVersion: 1, id: 'root', version: '1.0.0',
          breaks: { peer: '*' } }),
        capture('peer', 'manifest', { schemaVersion: 1, id: 'peer', version: '1.0.0' })]),
        selection: 'unsatisfiable' },
      { id: 'PKG08', request: modRequest('forge', 'root', [
        capture('root', 'manifest', 'modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\n[[mods]]\nmodId="root"\nversion="1.0.0"')]),
        selection: 'valid' },
      { id: 'PKG09', request: modRequest('modrinth', 'V1', [
        capture('V1', 'version', { id: 'V1', project_id: 'P1', dependencies: [
          { project_id: 'P2', version_id: 'V2', dependency_type: 'embedded' }] }),
        capture('V2', 'version', { id: 'V2', project_id: 'P2', dependencies: [] })]),
        selection: 'valid' },
      { id: 'PKG09-curseforge', request: modRequest('curseforge', '0', [
        { identity: '0', surface: 'file', status: 'inaccessible',
          bytesBase64: null, sha256: null,
          sourceUrl: 'https://api.curseforge.com/v1/mods/238222/files/0', httpStatus: 403 }]),
        selection: 'incomplete-source-data' },
      { id: 'PKG10', request: modRequest('nexus', 'game/mod/file', [
        { identity: 'game/mod/file', surface: 'file-version-range', status: 'inaccessible',
          bytesBase64: null, sha256: null,
          sourceUrl: 'https://api.nexusmods.com/v3/mod-file-versions/1/dependencies/ranges',
          httpStatus: 401 }]), selection: 'incomplete-source-data' },
      { id: 'PKG11', request: modRequest('steam', '123', [
        capture('123', 'ugc-children', { publishedfileid: '123', file_type: 0,
          num_children: 1, children: [{ publishedfileid: '456' }] })]), selection: 'valid' },
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
      const response = await write(resolveToken, `mod-${entry.id}-${randomUUID()}`, entry.request);
      expect(response.status).toBe(201);
      const result = await response.json() as { resolution: { outcome: { selection: string } } };
      expect(result.resolution.outcome.selection).toBe(entry.selection);
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
});
