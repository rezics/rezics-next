import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { accountRecoveryCoverage, assertAccountRecoveryCoverage }
  from '../../../services/account/src/recovery-coverage.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { publishAdmittedContent }
  from '../../../services/main/src/modules/content-publication/publish-admitted.ts';
import { assertContentRecoveryCoverage }
  from '../../../services/main/src/modules/work/content-recovery-coverage.ts';
import { initializeFreshGraph, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { accessStateCoverage, captureGraphRecoveryCoverage, cutoverRestoredGraphLineage,
  releaseRestoredGraphHold }
  from '../../../services/main/src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead }
  from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'd4'.repeat(32);

function rootCommand(args: string[], timeout: number): void {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
}

async function migrate(pool: Pool, owner: 'access' | 'relay'): Promise<void> {
  const directory = join(root, `services/main/migrations/${owner}`);
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
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

test('OPS03: signed Account, Access, Content and graph cut rejects mixed owner frontiers', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `owner-cut-${randomUUID().slice(0, 12)}`;
  const options = { profile: 'qa' as const, runId };
  const stackArgs = ['--profile', 'qa', '--run-id', runId];
  const pools: Pool[] = [];
  let accountApp: ReturnType<typeof createAccountApp> | undefined;
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const stack = stackDirectory(root, options);
    const apps = readEnv(join(stack, 'apps.env'));
    const compose = readEnv(join(stack, 'compose.env'));
    const accountPool = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    const relayPool = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    const accountFrontierPool = new Pool({ connectionString: `postgresql://postgres:${
      encodeURIComponent(compose.POSTGRES_PASSWORD!) }@127.0.0.1:${compose.POSTGRES_PORT}/account` });
    pools.push(accountPool, accessPool, contentPool, relayPool, accountFrontierPool);
    await migrate(accessPool, 'access');
    await migrate(relayPool, 'relay');
    await migrateContent(contentPool);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const operators = new Set<string>();
    const accountConfig = { baseURL: base, secret: apps.ACCOUNT_SECRET!,
      resource: apps.ACCOUNT_MAIN_RESOURCE!, pool: accountPool, operatorUserIds: operators };
    await (await getMigrations(accountAuthOptions(accountConfig))).runMigrations();
    const auth = createAccountAuth(accountConfig);
    accountApp = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
    const signUp = async (name: string) => {
      const email = `cut-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }) });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Recovery verifier', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const browserClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Recovery browser', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create work:edit',
        skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: member.email, password: member.password }) });
    expect(signIn.status).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: browserClient.client_id, redirect_uri: redirectUri,
      scope: 'openid work:create work:edit', state: randomUUID(),
      resource: apps.ACCOUNT_MAIN_RESOURCE!,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
    const authorized = await fetch(authorize, {
      headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code');
    if (!code) throw new Error('OAuth authorization code is absent');
    const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code',
        client_id: browserClient.client_id, code, redirect_uri: redirectUri,
        code_verifier: verifier, resource: apps.ACCOUNT_MAIN_RESOURCE! }) });
    expect(exchange.status).toBe(200);
    const bearer = `Bearer ${(await exchange.json() as { access_token: string }).access_token}`;
    const account = new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: apps.ACCOUNT_MAIN_RESOURCE!, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    const request = new Request('https://main.rezics.test/v1/works', {
      headers: { authorization: bearer } });
    const principal = await account.verify(request, ['work:create']);
    expect(principal).toEqual({ issuer: `${base}/api/auth`, subject: member.id });

    const actor = `https://rezics.com/id/${randomUUID()}`;
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
    const grant = async (scope: string, action: string) => {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
        [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), principalId, actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), actor, scope, action]);
    };
    await grant('work:create:root', 'work.create');
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    const env: WorkActivationEnvironment = { fuseki, lineage,
      objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
    await initializeFreshGraph(fuseki, lineage);
    const access = new AccessAdmissionRegistry(accessPool);
    const work = await createAdmittedMetadataWork(env, account, access, request,
      { title: 'Coordinated owner cut', actingSubject: actor,
        idempotencyKey: `owner-cut-work-${randomUUID()}` });
    expect(work.sequence).toBe('1');
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const content = new ContentCore(contentPool);
    const saved = await content.saveDraft({ operationId: `owner-cut-draft-${randomUUID()}`,
      variant: { id: variantId, resourceId: work.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'coordinated-owner-cut' },
      serializedJson: JSON.stringify({ body: 'Exact Content at the coordinated cut' }) });
    if (!saved.revisionId) throw new Error('Content revision was not saved');
    const exact = (await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('exact Content bytes are unavailable');
    await grant(`content:publish:${variantId}`, 'content.publish');
    const published = await publishAdmittedContent(env, content, account, access,
      new Request(request.url, { headers: { authorization: bearer } }), {
        preparationId: `owner-cut-prepare-${randomUUID()}`,
        revisionId: saved.revisionId, expectedDigest: exact.reference.byteDigest,
        expectedContentEpoch: saved.position.dataEpoch,
        resourceId: work.work, variantId, expectedPublicationHead: null,
        actingSubject: actor, idempotencyKey: `owner-cut-publish-${randomUUID()}` });
    expect(published.status).toBe('active');
    expect(published.graphSequence).toBe('2');
    const consumer = `owner-cut-${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, lineage.dataEpoch);
    expect((await relayMainOutboxOnce(fuseki, relayPool, consumer))?.sequence).toBe('1');
    expect((await relayMainOutboxOnce(fuseki, relayPool, consumer))?.sequence).toBe('2');
    await expect(captureGraphRecoveryCoverage(fuseki, accountFrontierPool,
      accessPool, relayPool, consumer, contentPool))
      .rejects.toThrow('Access recovery fence must be held for capture');
    await engageAccessRecoveryFence(accessPool);
    let coverage: Awaited<ReturnType<typeof captureGraphRecoveryCoverage>> | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { coverage = await captureGraphRecoveryCoverage(fuseki, accountFrontierPool,
        accessPool, relayPool, consumer, contentPool); break; }
      catch (error) {
        if (attempt === 4 || !String(error).includes('Account WAL frontier')) throw error;
        await Bun.sleep(200);
      }
    }
    if (!coverage?.content) throw new Error('coordinated Content coverage is absent');
    expect(coverage).toMatchObject({ priorDataEpoch: lineage.dataEpoch,
      priorSequence: '2', content: { dataEpoch: saved.position.dataEpoch } });
    expect(Number(coverage.content.graphReferencesCount)).toBeGreaterThan(0);
    const sealedCoverage = JSON.stringify(sealRecoveryPayload(
      coverage, recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relayPool, sealedCoverage, recoveryKey);
    const nextLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    const cutover = await cutoverRestoredGraphLineage(fuseki, {
      prior: { ...lineage, sequence: '2' }, next: nextLineage });
    expect(cutover.sequence).toBe('0');
    const heldEnv = { ...env, lineage: nextLineage };
    const heldApp = createMainApp(fuseki, { environment: heldEnv, account, access,
      content, contentAuthoring: content });
    expect((await heldApp.handle(new Request('http://localhost/health/ready'))).status).toBe(503);
    const heldRead = await heldApp.handle(new Request(
      `http://localhost/v1/content-revisions/${saved.revisionId}`
      + `?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: bearer } }));
    expect(heldRead.status).toBe(503);
    expect((await heldRead.json() as { code: string }).code).toBe('recovery_hold');
    await expect(releaseRestoredGraphHold(fuseki, accessPool, relayPool,
      nextLineage, { sealedCoverage, hmacKey: recoveryKey,
        accountPool: accountFrontierPool, contentPool }))
      .rejects.toThrow('Account WAL differs from recovery coverage');

    // Named mixed-cut faults, each checked against the signed owner cut. These
    // mutations are confined to this disposable project and never release hold.
    const beforeAccess = await accessStateCoverage(accessPool);
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalId]);
    expect(await accessStateCoverage(accessPool)).not.toEqual(beforeAccess);
    await expect(releaseRestoredGraphHold(fuseki, accessPool, relayPool,
      nextLineage, { sealedCoverage, hmacKey: recoveryKey,
        accountPool: accountFrontierPool, contentPool }))
      .rejects.toThrow('Access state differs from recovery coverage');
    const newer = await content.saveDraft({ operationId: `owner-cut-newer-${randomUUID()}`,
      variant: { id: variantId, resourceId: work.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: saved.revisionId, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'newer-unused-content-cut' },
      serializedJson: JSON.stringify({ body: 'Newer body has no graph decision' }) });
    expect(newer.outcome).toBe('succeeded');
    await expect(assertContentRecoveryCoverage(contentPool, fuseki, coverage.content))
      .rejects.toThrow('Content');
    const beforeAccount = await accountRecoveryCoverage(accountFrontierPool);
    await signUp('newer-account');
    expect(await accountRecoveryCoverage(accountFrontierPool)).not.toEqual(beforeAccount);
    await expect(assertAccountRecoveryCoverage(accountFrontierPool, coverage.account))
      .rejects.toThrow('Account rows differ from retained recovery coverage');
    expect((await heldApp.handle(new Request('http://localhost/health/ready'))).status).toBe(503);
  } finally {
    await accountApp?.stop();
    await Promise.all(pools.map(pool => pool.end()));
    if (started) rootCommand(['stack:reset', ...stackArgs], 120_000);
  }
}, 240_000);
