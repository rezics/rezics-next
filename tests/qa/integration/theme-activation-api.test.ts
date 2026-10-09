import { isForegroundOperation } from './support/operation-cost.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, setSystemTime, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult,
  type CommandHealth, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ThemeStore } from '../../../services/main/src/modules/theme/store.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const root = resolve(import.meta.dir, '../../..');
const native = (id: string) => 'https://rezics.com/id/' + id;

class MeteredFusekiClient extends FusekiClient {
  calls = 0;
  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    if (isForegroundOperation()) this.calls++;
    return super.query(sparql, maxResponseBytes);
  }
  override async commandHealth(): Promise<CommandHealth> {
    if (isForegroundOperation()) this.calls++;
    return super.commandHealth();
  }
  override async command(envelope: CommandEnvelope): Promise<CommandResult> {
    if (isForegroundOperation()) this.calls++;
    return super.command(envelope);
  }
}

class FailOnceThemeStore extends ThemeStore {
  failed = false;
  override async record(record: Parameters<ThemeStore['record']>[0]): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('injected Content projection interruption');
    }
    return super.record(record);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('VIEW09: changed dependencies and expired approval require a new exact theme approval', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCOUNT_MAIN_RESOURCE) throw new Error('Run through the isolated QA integration tier');
  const state = join(root, '.temp', 'theme-activation-' + randomUUID());
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access'], 'owner');
  const accountPool = new Pool({ connectionString: databases.urls.account });
  const accessPool = new Pool({ connectionString: databases.urls.access });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  await migrateContent(contentPool);
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const accountApp = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  try {
    async function signUp(name: string) {
      const email = 'theme-' + name + '-' + randomUUID() + '@example.test';
      const password = randomBytes(24).toString('base64url');
      const response = await accountApp.handle(new Request(base + '/api/auth/sign-up/email', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { user: { id: string } };
      return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
    }
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders, body: {
      client_name: 'Theme verifier', scope: 'theme:approve theme:read',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['theme:approve', 'theme:read'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const client = await auth.api.adminCreateOAuthClient({ headers: adminHeaders, body: {
      client_name: 'Theme native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: 'openid theme:approve theme:read',
      skip_consent: true, require_pkce: true } });
    async function tokenFor(user: { email: string; password: string }, scope: string) {
      const signedIn = await fetch(base + '/api/auth/sign-in/email', { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signedIn.status).toBe(200);
      return (await signIn({
        account: base, clientId: client.client_id, redirectUri, scope,
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
      }, signedIn.headers.get('set-cookie')!)).accessToken;
    }

    const owner = await signUp('owner');
    const outsider = await signUp('outsider');
    const ownerToken = await tokenFor(owner, 'openid theme:approve theme:read');
    const readOnlyToken = await tokenFor(owner, 'openid theme:read');
    const outsiderToken = await tokenFor(outsider, 'openid theme:approve theme:read');
    const ownerSubject = native(randomUUID()), outsiderSubject = native(randomUUID());
    const ownerPrincipal = randomUUID(), outsiderPrincipal = randomUUID();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3),($4,$2,$5)`,
    [ownerPrincipal, base + '/api/auth', owner.id, outsiderPrincipal, outsider.id]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind)
      VALUES ($1,'agent'),($2,'agent')`, [ownerSubject, outsiderSubject]);

    const fuseki = new MeteredFusekiClient(Bun.env.FUSEKI_URL);
    const environment = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: join(state, 'objects') };
    const verifier = new AccountAssertionVerifier({ issuer: base + '/api/auth',
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: base + '/api/auth/jwks',
      introspectUrl: base + '/api/auth/oauth2/introspect',
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    const access = new AccessAdmissionRegistry(accessPool);
    const store = new ThemeStore(contentPool);
    const main = (themes: ThemeStore = store) => createMainApp(fuseki, {
      environment, account: verifier, access, themes,
    });
    const app = main();
    const newTheme = randomUUID();
    const activate = (theme: string, bearer: string, actingSubject: string, dependencyDigest: string,
      expectedRevision: string | null, expiry: string, key = 'theme-' + randomUUID()) =>
      main().handle(new Request('http://main.local/v1/themes/' + theme + '/activations', {
        method: 'POST', headers: { authorization: 'Bearer ' + bearer,
          'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ profile: 'theme-activation-request-v1', owner: actingSubject,
          expectedRevision, dependencyDigest, origin: 'https://themes.example.test',
          capabilities: { data: 'public-only', secrets: false,
            networkOrigins: ['https://cdn.example.test'], cpuMs: 1500, memoryMiB: 64 },
          approvalExpiresAt: expiry, actingSubject, idempotencyKey: key }),
      }));
    const read = (theme: string, bearer = ownerToken) => app.handle(new Request(
      'http://main.local/v1/themes/' + theme, { headers: { authorization: 'Bearer ' + bearer } }));
    async function grant(theme: string, subject: string, principal: string, withPermission = true) {
      const scope = 'theme:approve:' + theme;
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,'theme.approve',now() + interval '1 hour')`,
      [randomUUID(), principal, subject]);
      if (withPermission) await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,'theme.approve',now() + interval '1 hour')`,
      [randomUUID(), subject, scope]);
    }
    await grant(newTheme, ownerSubject, ownerPrincipal);
    await grant(newTheme, outsiderSubject, outsiderPrincipal, false);

    const firstKey = 'theme-first-' + randomUUID();
    const firstExpiry = new Date(Math.ceil((Date.now() + 120_000) / 1000) * 1000).toISOString();
    const firstDigest = createHash('sha256').update('dependency-set-a').digest('hex');
    fuseki.calls = 0;
    store.statements = 0;
    const firstResponse = await activate(newTheme, ownerToken, ownerSubject, firstDigest, null,
      firstExpiry, firstKey);
    if (firstResponse.status !== 201) throw new Error('theme activation failed: ' + await firstResponse.clone().text());
    expect(firstResponse.status).toBe(201);
    expect(fuseki.calls).toBeLessThanOrEqual(8);
    expect(store.statements).toBeLessThanOrEqual(10);
    const first = await firstResponse.json() as { revision: string; approvalId: string;
      approvalGeneration: string; active: boolean; dependencyDigest: string };
    expect(first).toMatchObject({ approvalGeneration: '1', dependencyDigest: firstDigest, active: true });
    fuseki.calls = 0;
    const firstView = await read(newTheme);
    expect(firstView.status).toBe(200);
    expect(fuseki.calls).toBeLessThanOrEqual(1);
    // Advance only the application clock; the approval can be committed without racing a short expiry.
    try {
      setSystemTime(new Date(Date.parse(firstExpiry) + 1));
      const expired = await read(newTheme);
      expect(expired.status).toBe(200);
      expect(await expired.json()).toMatchObject({ state: 'expired', active: false,
        revision: first.revision, approvalId: first.approvalId });
    } finally { setSystemTime(); }

    const secondDigest = createHash('sha256').update('dependency-set-b').digest('hex');
    const secondKey = 'theme-second-' + randomUUID();
    const secondExpiry = new Date(Date.now() + 300_000).toISOString();
    fuseki.calls = 0;
    store.statements = 0;
    const secondResponse = await activate(newTheme, ownerToken, ownerSubject, secondDigest,
      first.revision, secondExpiry, secondKey);
    expect(secondResponse.status).toBe(201);
    expect(fuseki.calls).toBeLessThanOrEqual(8);
    expect(store.statements).toBeLessThanOrEqual(10);
    const second = await secondResponse.json() as { revision: string; approvalId: string;
      approvalGeneration: string; dependencyDigest: string; active: boolean };
    expect(second).toMatchObject({ approvalGeneration: '2', dependencyDigest: secondDigest, active: true });
    expect(second.revision).not.toBe(first.revision);
    expect(second.approvalId).not.toBe(first.approvalId);

    fuseki.calls = 0;
    store.statements = 0;
    try {
      setSystemTime(new Date(Date.parse(firstExpiry) + 1));
      const replay = await activate(newTheme, ownerToken, ownerSubject, firstDigest, null,
        firstExpiry, firstKey);
      if (replay.status !== 200) throw new Error('theme activation replay failed: ' + await replay.clone().text());
      expect(replay.status).toBe(200);
      expect(fuseki.calls).toBeLessThanOrEqual(2);
      expect(store.statements).toBeLessThanOrEqual(6);
      expect(await replay.json()).toMatchObject({ revision: first.revision, active: false, replayed: true });
    } finally { setSystemTime(); }
    fuseki.calls = 0;
    const keyConflict = await activate(newTheme, ownerToken, ownerSubject, secondDigest,
      second.revision, new Date(Date.now() + 60_000).toISOString(), firstKey);
    expect(keyConflict.status).toBe(409);
    expect(fuseki.calls).toBeLessThanOrEqual(2);
    expect(await (await read(newTheme)).json()).toMatchObject({ revision: second.revision,
      dependencyDigest: secondDigest, state: 'active', active: true });
    fuseki.calls = 0;
    expect((await read(newTheme, readOnlyToken)).status).toBe(200);
    expect(fuseki.calls).toBeLessThanOrEqual(1);
    const noThemeScopeToken = await tokenFor(owner, 'openid');
    fuseki.calls = 0;
    expect((await read(newTheme, noThemeScopeToken)).status).toBe(403);
    expect(fuseki.calls).toBeLessThanOrEqual(1);
    fuseki.calls = 0;
    expect((await activate(newTheme, readOnlyToken, ownerSubject, secondDigest,
      second.revision, new Date(Date.now() + 60_000).toISOString())).status).toBe(403);
    expect(fuseki.calls).toBeLessThanOrEqual(2);
    fuseki.calls = 0;
    expect((await activate(newTheme, outsiderToken, outsiderSubject, secondDigest,
      second.revision, new Date(Date.now() + 60_000).toISOString())).status).toBe(403);
    expect(fuseki.calls).toBeLessThanOrEqual(2);

    fuseki.calls = 0;
    const stale = await activate(newTheme, ownerToken, ownerSubject,
      createHash('sha256').update('stale').digest('hex'), first.revision,
      new Date(Date.now() + 60_000).toISOString());
    expect(stale.status).toBe(409);
    expect(fuseki.calls).toBeLessThanOrEqual(8);
    fuseki.calls = 0;
    const deniedExpiry = await activate(newTheme, ownerToken, ownerSubject, secondDigest,
      second.revision, new Date(Date.now() - 1000).toISOString());
    expect(deniedExpiry.status).toBe(403);
    expect(fuseki.calls).toBeLessThanOrEqual(4);
    expect(await (await read(newTheme)).json()).toMatchObject({ revision: second.revision, state: 'active' });

    const raceDigestA = createHash('sha256').update('race-a').digest('hex');
    const raceDigestB = createHash('sha256').update('race-b').digest('hex');
    fuseki.calls = 0;
    store.statements = 0;
    const race = await Promise.all([
      activate(newTheme, ownerToken, ownerSubject, raceDigestA, second.revision,
        new Date(Date.now() + 60_000).toISOString()),
      activate(newTheme, ownerToken, ownerSubject, raceDigestB, second.revision,
        new Date(Date.now() + 60_000).toISOString()),
    ]);
    const raceResults = await Promise.all(race.map(async response => ({
      status: response.status, body: await response.clone().text(),
    })));
    const raceStatuses = raceResults.map(result => result.status).sort();
    if (JSON.stringify(raceStatuses) !== JSON.stringify([201, 409])) {
      throw new Error(`Unexpected concurrent activation outcomes: ${JSON.stringify(raceResults)}`);
    }
    expect(fuseki.calls).toBeLessThanOrEqual(16);
    expect(store.statements).toBeLessThanOrEqual(10);
    const winner = await (race.find(response => response.status === 201)!).json() as { revision: string };
    expect(await (await read(newTheme)).json()).toMatchObject({ revision: winner.revision, state: 'active' });

    const partialTheme = randomUUID();
    await grant(partialTheme, ownerSubject, ownerPrincipal);
    const interruptedStore = new FailOnceThemeStore(contentPool);
    const interruptedApp = main(interruptedStore);
    const partialKey = 'theme-partial-' + randomUUID();
    const partialBody = { profile: 'theme-activation-request-v1', owner: ownerSubject,
      expectedRevision: null, dependencyDigest: createHash('sha256').update('partial').digest('hex'),
      origin: 'https://themes.example.test',
      capabilities: { data: 'public-only', secrets: false,
        networkOrigins: ['https://cdn.example.test'], cpuMs: 1500, memoryMiB: 64 },
      approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      actingSubject: ownerSubject, idempotencyKey: partialKey };
    const partialRequest = () => interruptedApp.handle(new Request(
      'http://main.local/v1/themes/' + partialTheme + '/activations', {
        method: 'POST', headers: { authorization: 'Bearer ' + ownerToken,
          'content-type': 'application/json', 'idempotency-key': partialKey },
        body: JSON.stringify(partialBody),
      }));
    fuseki.calls = 0;
    expect((await partialRequest()).status).toBe(503);
    expect(fuseki.calls).toBeLessThanOrEqual(8);
    fuseki.calls = 0;
    store.statements = 0;
    expect((await partialRequest()).status).toBe(200);
    expect(fuseki.calls).toBeLessThanOrEqual(2);
    expect(store.statements).toBeLessThanOrEqual(6);
    expect(await (await interruptedApp.handle(new Request('http://main.local/v1/themes/' + partialTheme, {
      headers: { authorization: 'Bearer ' + ownerToken },
    }))).json()).toMatchObject({ dependencyDigest: partialBody.dependencyDigest, state: 'active' });
  } finally {
    await accountApp.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end(), databases.close()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 30_000);
