import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { copyRecoveryTree } from '../support/recovery-copy.ts';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { installConsentRefreshFence } from '../../../services/account/src/consent-fence.ts';
import { accountRecoveryCoverage } from '../../../services/account/src/recovery-coverage.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { GoProxyCaptureStore }
  from '../../../services/main/src/modules/package/go-proxy-capture.ts';
import { graphObjectReferences }
  from '../../../services/main/src/modules/owner/object-coverage.ts';
import { OwnerOperations } from '../../../services/main/src/modules/owner/operations.ts';
import { GoMvsResolutionStore, type GoCapturedResolutionRequest, type GoMvsResolution }
  from '../../../services/main/src/modules/package/go-mvs.ts';
import { type IncludedGoSumdbLookup }
  from '../../../services/main/src/modules/package/go-sumdb-lookup.ts';
import { GoSumdbTrustStore }
  from '../../../services/main/src/modules/package/go-sumdb-trust.ts';
import { CargoResolutionStore }
  from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { publishAdmittedContent }
  from '../../../services/main/src/modules/content-publication/publish-admitted.ts';
import { accessStateTables } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { assertContentRecoveryCoverage, captureContentRecoveryCoverage }
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
import includedGoSumdb from '../fixtures/go-sumdb-x-sync.json';
import latestGoSumdb from '../fixtures/go-sumdb-latest.json';
import { cargoLinksFixture } from '../fixtures/cargo-links-snapshot.ts';
import { cargoLockFixture } from '../fixtures/cargo-lock-snapshot.ts';
import { npmFixture } from '../fixtures/npm-lock-snapshot.ts';
import { npmPlatformFixture, npmTargets } from '../fixtures/npm-platform-snapshot.ts';
import { npmIdentityFixture } from '../fixtures/npm-identity-snapshot.ts';
import { npmCompositionFixture, npmCompositionTargets } from '../fixtures/npm-composition-snapshot.ts';
import { npmPolicyFixture } from '../fixtures/npm-policy-snapshot.ts';
import { NpmResolutionStore, NpmResolutionUnavailable }
  from '../../../services/main/src/modules/package/npm-resolution.ts';
import { goManifest, goPrunedFixtureResponse, goPrunedMain, goPrunedSources,
  goRequirement, goSha } from '../fixtures/go-pruned-directives.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'd4'.repeat(32);

function rootCommand(args: string[], timeout: number): string {
  const result = spawnSync(...scriptCommand(args), { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
  return result.stdout.trim();
}

async function migrate(pool: Pool, owner: 'access' | 'relay'): Promise<void> {
  const directory = join(root, `services/main/migrations/${owner}`);
  for (const file of schemaFiles(root, owner)) {
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

test('OPS03/PKG14/SYS12: signed owner cut restores Content and exact Go checksum proof', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `owner-cut-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const options = { profile: 'qa' as const, runId };
  const stackArgs = ['--profile', 'qa', '--run-id', runId];
  const state = join(root, '.temp', `owner-cut-pg-${randomUUID()}`);
  const restoredData = join(state, 'restored');
  const socketDirectory = join(root, '.temp', 's');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const pools: Pool[] = [];
  let accountApp: ReturnType<typeof createAccountApp> | undefined;
  let started = false;
  let restoredStartAttempted = false;
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
    await installConsentRefreshFence(accountPool);
    const auth = createAccountAuth(accountConfig);
    accountApp = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
    const signUp = async (name: string) => {
      const email = `cut-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }) });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Recovery verifier', scope: 'work:create owner:operate',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create', 'owner:operate'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const browserClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Recovery browser', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create work:edit owner:operate',
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
      scope: 'openid work:create work:edit owner:operate', state: randomUUID(),
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
    expect(principal).toEqual({ issuer: `${base}/api/auth`, subject: member.id,
      currentAssertion: expect.any(Function),
      accountAudiences: [apps.ACCOUNT_MAIN_RESOURCE!, `${base}/api/auth/oauth2/userinfo`],
      accountAuthMode: 'trusted',
      accountExpiresAt: JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString()).exp, accountClientId: browserClient.client_id,
      accountConsentGeneration: undefined, accountConsentId: undefined,
      accountScopes: ['openid', 'work:create', 'work:edit', 'owner:operate'] });

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
      { title: 'Coordinated owner cut', language: 'en', actingSubject: actor,
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
    const packageCaptures = new GoProxyCaptureStore(contentPool,
      (async (value: RequestInfo | URL) => {
        const url = String(value);
        const pruned = goPrunedFixtureResponse(url);
        if (pruned) return pruned;
        if (url.endsWith('/@v/list')) return new Response('v0.1.0\n');
        if (url.endsWith('.info')) return new Response(JSON.stringify({
          Version: 'v0.1.0', Time: '2022-10-01T00:00:00Z' }));
        if (url.endsWith('.mod')) return new Response('module golang.org/x/sync\n');
        return new Response('', { status: 404 });
      }) as typeof fetch);
    const packageReceiptKey = `owner-cut-go-${randomUUID()}`;
    const packageCapture = (await packageCaptures.capture(principalId,
      `owner-cut-go-${randomUUID()}`, { profile: 'go-module-proxy-capture-v1',
        path: 'golang.org/x/sync', version: 'v0.1.0' }))
      .capture.capture.split('/').at(-1)!;
    const packageTrust = new GoSumdbTrustStore(contentPool, packageCaptures,
      (async () => includedGoSumdb as IncludedGoSumdbLookup) as
        ConstructorParameters<typeof GoSumdbTrustStore>[2],
      (async () => []) as ConstructorParameters<typeof GoSumdbTrustStore>[3],
      (async () => latestGoSumdb) as ConstructorParameters<typeof GoSumdbTrustStore>[4]);
    const packageReceipt = (await packageTrust.verify(principalId,
      packageReceiptKey, packageCapture))!.verification;
    const packageVerification = packageReceipt.verification.split('/').at(-1)!;
    const goCaptures: string[] = [];
    for (const source of goPrunedSources) {
      const captured = await packageCaptures.capture(principalId,
        `owner-cut-go-source-${randomUUID()}`, { profile: 'go-module-proxy-capture-v1',
          path: source.path, version: source.version });
      goCaptures.push(captured.capture.capture.split('/').at(-1)!);
    }
    const goResolutions = new GoMvsResolutionStore(contentPool, packageCaptures);
    const goReceipts: Array<{ key: string; receipt: GoMvsResolution }> = [];
    for (const directed of [false, true]) {
      const key = `owner-cut-go-${randomUUID()}`;
      const receipt = (await goResolutions.resolve(principalId, key, {
        profile: directed ? 'go-mvs-stable-unpruned-main-directives-v2' : 'go-mvs-stable-unpruned-v1',
        mainModule: 'example.com/main', goDirective: '1.16',
        coverage: { complete: true, unsupportedClauses: [] },
        roots: [], releases: [],
        ...(directed ? { mainDirectives: { exclusions: [], replacements: [] } } : {}),
      })).resolution;
      goReceipts.push({ key, receipt });
    }
    const prunedRequest: GoCapturedResolutionRequest = {
      profile: 'go-mvs-from-main-pruned-directives-captures-v5',
      mainManifestBase64: Buffer.from(goPrunedMain).toString('base64'), captures: goCaptures,
    };
    const local = goManifest('example.com/a', '1.16');
    const captureRequests: GoCapturedResolutionRequest[] = [
      { profile: 'go-mvs-from-main-captures-v2', captures: [],
        mainManifestBase64: Buffer.from(goManifest('example.com/main', '1.16')).toString('base64') },
      { profile: 'go-mvs-from-main-local-captures-v3', captures: [],
        mainManifestBase64: Buffer.from(`${goManifest('example.com/main', '1.16',
          [goRequirement('example.com/a')])}replace example.com/a => ./local\n`).toString('base64'),
        localSources: [{ identity: './local', goModBase64: Buffer.from(local).toString('base64'),
          rawSha256: goSha(local) }] },
      { profile: 'go-mvs-from-main-pruned-captures-v4', captures: goCaptures,
        mainManifestBase64: Buffer.from(goManifest('example.com/main', '1.17',
          [goRequirement('example.com/b')])).toString('base64') },
      prunedRequest,
    ];
    for (const input of captureRequests) {
      const key = `owner-cut-go-${randomUUID()}`;
      goReceipts.push({ key, receipt: (await goResolutions.resolveFromCaptures(principalId,
        key, input)).resolution });
    }
    expect(goReceipts.map(item => item.receipt.outcome.status)).toEqual(Array(6).fill('solved'));
    for (const { receipt } of goReceipts.slice(0, 5)) {
      expect(receipt.outcome).not.toHaveProperty('selectedSourceEvidence');
    }
    const cargoResolutions = new CargoResolutionStore(contentPool);
    const cargoRequest = cargoLinksFixture();
    const cargoKey = `owner-cut-cargo-${randomUUID()}`;
    const cargoV1Request = { ...cargoRequest, profile: 'cargo-index-exact-resolver2-v1' as const };
    const cargoV1 = (await cargoResolutions.resolve(principalId, `${cargoKey}-v1`, cargoV1Request)).resolution;
    const cargoV2 = (await cargoResolutions.resolve(principalId, cargoKey, cargoRequest)).resolution;
    const cargoV3Request = cargoLockFixture();
    const cargoV3 = (await cargoResolutions.resolve(principalId, `${cargoKey}-v3`, cargoV3Request)).resolution;
    expect(cargoV1.outcome.status).toBe('unsupported-semantics');
    expect(cargoV1.outcome).not.toHaveProperty('linksConflicts');
    expect(cargoV2.outcome.status).toBe('unsatisfiable');
    expect(cargoV3.outcome).toMatchObject({ status: 'solved',
      lockEvidence: { provenance: 'caller-supplied', sha256: cargoV3Request.existingLock!.sha256 },
      reusedYanked: [{ name: 'leaf', lockSource: `sparse+${cargoV3Request.registryIndexUrl}` }] });
    const npmStore = new NpmResolutionStore(contentPool);
    const npmRequest = npmFixture();
    const npmKey = `owner-cut-npm-${randomUUID()}`;
    const npmReceipt = (await npmStore.resolve(principalId, npmKey, npmRequest)).resolution;
    const npmId = npmReceipt.resolution.split('/').at(-1)!;
    expect(npmReceipt.outcome.status).toBe('validated');
    const npmPlatformReceipts = [];
    for (const target of npmTargets.slice(0, 2)) {
      const request = npmPlatformFixture('platform-branch', target);
      const key = `${npmKey}-${target.os}`;
      const receipt = (await npmStore.resolve(principalId, key, request)).resolution;
      expect(receipt).toMatchObject({ profile: 'npm-lock-topology-receipt-v2', outcome: { status: 'validated', target } });
      npmPlatformReceipts.push({ request, key, receipt, id: receipt.resolution.split('/').at(-1)! });
    }
    const npmIdentityReceipts = [];
    for (const kind of ['two-aliases', 'workspace-internal'] as const) {
      const request = npmIdentityFixture(kind);
      const key = `${npmKey}-${kind}`;
      const receipt = (await npmStore.resolve(principalId, key, request)).resolution;
      expect(receipt).toMatchObject({ profile: 'npm-lock-topology-receipt-v3', outcome: { status: 'validated' } });
      npmIdentityReceipts.push({ request, key, receipt, id: receipt.resolution.split('/').at(-1)! });
    }
    const npmCompositionReceipts = [];
    for (const target of npmCompositionTargets) {
      const request = npmCompositionFixture('workspace-optional-child', target);
      const key = `${npmKey}-composed-${target.os}-${target.cpu}`;
      const receipt = (await npmStore.resolve(principalId, key, request)).resolution;
      expect(receipt).toMatchObject({ profile: 'npm-lock-topology-receipt-v4', outcome: { status: 'validated', target } });
      npmCompositionReceipts.push({ request, key, receipt, id: receipt.resolution.split('/').at(-1)! });
    }
    const npmPolicyRequest = npmPolicyFixture();
    const npmPolicyKey = `${npmKey}-policy-v5`;
    const npmPolicyReceipt = (await npmStore.resolve(principalId, npmPolicyKey, npmPolicyRequest)).resolution;
    expect(npmPolicyReceipt).toMatchObject({ profile: 'npm-lock-topology-receipt-v5',
      outcome: { status: 'validated', overrideSelections: [expect.objectContaining({ name: 'leaf' })] } });
    const npmPolicyReceipts = [{ request: npmPolicyRequest, key: npmPolicyKey,
      receipt: npmPolicyReceipt, id: npmPolicyReceipt.resolution.split('/').at(-1)! }];
    const packageOnlyCoverage = await captureContentRecoveryCoverage(contentPool, []);
    expect(packageOnlyCoverage.graphReferencesCount).toBe('0');
    expect(packageOnlyCoverage.tables['pkg.go_proxy_capture']!.count).toBe('7');
    expect(packageOnlyCoverage.tables['pkg.go_resolution']!.count).toBe('6');
    expect(packageOnlyCoverage.tables['pkg.go_sumdb_verification']!.count).toBe('1');
    expect(packageOnlyCoverage.tables['pkg.cargo_resolution']!.count).toBe('3');
    expect(packageOnlyCoverage.tables['pkg.npm_resolution']!.count).toBe('10');
    await grant(`work:read:${work.work}`, 'work.read');
    await grant(`content:publish:${work.work}`, 'content.publish');
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
    const fenceGeneration = await engageAccessRecoveryFence(accessPool);
    let coverage: Awaited<ReturnType<typeof captureGraphRecoveryCoverage>> | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { coverage = await captureGraphRecoveryCoverage(fuseki, accountFrontierPool,
        accessPool, relayPool, consumer, contentPool,
        { directory: env.objectDirectory }); break; }
      catch (error) {
        if (attempt === 4 || !String(error).includes('Account WAL frontier')) throw error;
        await Bun.sleep(200);
      }
    }
    if (!coverage?.content) throw new Error('coordinated Content coverage is absent');
    const capturedAccess = await accessStateTables(accessPool);
    expect(coverage).toMatchObject({ priorDataEpoch: lineage.dataEpoch,
      priorSequence: '2', content: { dataEpoch: saved.position.dataEpoch } });
    expect(Number(coverage.content.graphReferencesCount)).toBeGreaterThan(0);
    expect(coverage.content.version).toBe(5);
    expect(Number(coverage.objects?.anchorCount)).toBeGreaterThan(0);
    // Version 5 discovers every Content owner schema, including source and verification.
    expect(Object.keys(coverage.content.tables)).toEqual(expect.arrayContaining([
      'content.revision', 'content.receipt_action', 'pkg.go_sumdb_head', 'source.record',
      'source.observation', 'verification.receipt', 'verification.evidence_item']));
    expect(coverage.content.excluded).toEqual({});
    expect(coverage.content.tables['pkg.go_proxy_capture']!.count).toBe('7');
    expect(coverage.content.tables['pkg.go_resolution']!.count).toBe('6');
    expect(coverage.content.tables['pkg.go_sumdb_verification']!.count).toBe('1');
    expect(coverage.content.tables['pkg.cargo_resolution']!.count).toBe('3');
    expect(coverage.content.tables['pkg.npm_resolution']!.count).toBe('10');
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

    // The source remains fenced. Backup runs through the project's container
    // loopback replication rule, without opening host-bridge replication access.
    const baseBackup = rootCommand(['stack:backup', ...stackArgs], 100_000);
    execFileSync('pg_verifybackup', ['--no-parse-wal', baseBackup],
      { cwd: state, timeout: 15_000 });
    copyRecoveryTree(baseBackup, restoredData);
    appendFileSync(join(restoredData, 'postgresql.auto.conf'),
      "\narchive_mode = off\nrestore_command = 'false'\n");
    writeFileSync(join(restoredData, 'recovery.signal'), '');
    const restoredPort = await freePort();
    restoredStartAttempted = true;
    const restoredLog = join(state, 'restored-postgres.log');
    // Cold backup recovery syncs the copied directory before accepting connections.
    try {
      execFileSync('pg_ctl', ['-D', restoredData, '-l', restoredLog,
        '-o', `-h 127.0.0.1 -p ${restoredPort} -k ${socketDirectory}`, '-t', '60', '-w', 'start'],
      { cwd: state, timeout: 65_000 });
    } catch (error) {
      // Cleanup removes the data directory; retain the startup diagnosis in QA output.
      throw new Error(`Restored PostgreSQL startup failed:\n${readFileSync(restoredLog, 'utf8').slice(-8_000)}`,
        { cause: error });
    }
    const restoredPool = (database: string, user: string, password: string) => new Pool({
      host: '127.0.0.1', port: restoredPort, database, user, password,
    });
    const restoredAccount = restoredPool('account', 'postgres', compose.POSTGRES_PASSWORD!);
    const restoredAccess = restoredPool('access', 'access', compose.REZICS_ACCESS_PASSWORD!);
    const restoredContent = restoredPool('content', 'content', compose.REZICS_CONTENT_PASSWORD!);
    const restoredRelay = restoredPool('relay', 'relay', compose.REZICS_RELAY_PASSWORD!);
    pools.push(restoredAccount, restoredAccess, restoredContent, restoredRelay);
    // pg_ctl -w returns when the server accepts connections, which can be
    // before the disposable backup has finished WAL replay and promoted.
    let recovering = true;
    for (let attempt = 0; attempt < 100 && recovering; attempt += 1) {
      recovering = (await restoredAccount.query<{ recovering: boolean }>(
        'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering ?? true;
      if (recovering) await Bun.sleep(100);
    }
    expect(recovering).toBe(false);
    expect(await accountRecoveryCoverage(restoredAccount)).toEqual(coverage.account);
    expect(await accessStateCoverage(restoredAccess)).toEqual(await accessStateCoverage(accessPool));
    await assertContentRecoveryCoverage(restoredContent, fuseki, coverage.content);
    const restoredPackageCaptures = new GoProxyCaptureStore(restoredContent,
      (async () => { throw new Error('restored exact read fetched provider'); }) as unknown as typeof fetch);
    const restoredPackageTrust = new GoSumdbTrustStore(restoredContent,
      restoredPackageCaptures,
      (async () => { throw new Error('restored replay fetched checksum database'); }) as
        ConstructorParameters<typeof GoSumdbTrustStore>[2]);
    expect(await restoredPackageTrust.read(principalId, packageVerification))
      .toEqual(packageReceipt);
    expect(await restoredPackageTrust.verify(principalId,
      packageReceiptKey, packageCapture)).toEqual({
        verification: packageReceipt, replayed: true });
    const restoredGo = new GoMvsResolutionStore(restoredContent, restoredPackageCaptures);
    for (const { key, receipt } of goReceipts) {
      const id = receipt.resolution.split('/').at(-1)!;
      expect(await restoredGo.read(principalId, id)).toEqual(receipt);
      expect(await restoredGo.resolve(principalId, key, receipt.request))
        .toEqual({ resolution: receipt, replayed: true });
      expect(await restoredGo.read(randomUUID(), id)).toBeNull();
    }
    expect(await restoredGo.resolveFromCaptures(principalId, goReceipts[5]!.key,
      prunedRequest)).toEqual({ resolution: goReceipts[5]!.receipt, replayed: true });
    const restoredCargo = new CargoResolutionStore(restoredContent);
    for (const [key, request, receipt] of [[`${cargoKey}-v1`, cargoV1Request, cargoV1],
      [cargoKey, cargoRequest, cargoV2], [`${cargoKey}-v3`, cargoV3Request, cargoV3]] as const) {
      expect(await restoredCargo.read(principalId, receipt.resolution.split('/').at(-1)!))
        .toEqual(receipt);
      expect(await restoredCargo.resolve(principalId, key, request))
        .toEqual({ resolution: receipt, replayed: true });
      expect(await restoredCargo.read(randomUUID(), receipt.resolution.split('/').at(-1)!)).toBeNull();
    }
    const restoredNpm = new NpmResolutionStore(restoredContent);
    expect(await restoredNpm.read(principalId, npmId)).toEqual(npmReceipt);
    expect(await restoredNpm.resolve(principalId, npmKey, npmRequest))
      .toEqual({ resolution: npmReceipt, replayed: true });
    expect(await restoredNpm.read(randomUUID(), npmId)).toBeNull();
    for (const { request, key, receipt, id } of [...npmPlatformReceipts, ...npmIdentityReceipts,
      ...npmCompositionReceipts, ...npmPolicyReceipts]) {
      expect(await restoredNpm.read(principalId, id)).toEqual(receipt);
      expect(await restoredNpm.resolve(principalId, key, request)).toEqual({ resolution: receipt, replayed: true });
      expect(await restoredNpm.read(randomUUID(), id)).toBeNull();
    }
    const restoredEvidence = { sealedCoverage, hmacKey: recoveryKey,
      accountPool: restoredAccount, contentPool: restoredContent,
      objectStore: { directory: env.objectDirectory } };
    const restoreOperations = new OwnerOperations(restoredRelay, heldEnv, {
      accountPool: restoredAccount, accessPool: restoredAccess, contentPool: restoredContent,
      hmacKey: recoveryKey, objectStore: { directory: env.objectDirectory } });
    const restoreApp = createMainApp(fuseki, { environment: heldEnv, account,
      access: new AccessAdmissionRegistry(restoredAccess),
      content: new ContentCore(restoredContent),
      contentAuthoring: new ContentCore(restoredContent), ownerOperations: restoreOperations });
    const restoreRequest = (key: string, token = bearer, sealed = sealedCoverage,
      sealedDeletionSets: string[] = []) =>
      restoreApp.handle(new Request('http://localhost/v1/owners/reconciliations', {
        method: 'POST', headers: { authorization: token,
          'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ profile: 'owner-reconciliation-v1',
          kind: 'restore', sealedCoverage: sealed, sealedDeletionSets }) }));
    expect((await restoreRequest(`denied-${randomUUID()}`, 'Bearer denied')).status).toBe(401);
    const extraSetKey = `extra-deletion-set-${randomUUID()}`;
    const extraSet = await restoreRequest(extraSetKey, bearer, sealedCoverage, ['not-a-sealed-set']);
    expect(extraSet.status).toBe(201);
    expect(await extraSet.json()).toMatchObject({ state: 'held', disposition: 'conflict' });
    expect((await restoreRequest(extraSetKey)).status).toBe(409);
    expect((await accessStateTables(restoredAccess)).tables).toEqual(capturedAccess.tables);

    // Each mismatch is committed in the disposable replay copy, then reversed
    // before the successful release. The source primary and its fences stay put.
    const extraSubject = `https://rezics.com/id/${randomUUID()}`;
    const lastChange = (await restoredAccess.query<{ id: string }>(
      'SELECT coalesce(max(id), 0)::text AS id FROM access.also_enjoyed_source_change')).rows[0]!.id;
    await restoredAccess.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')",
      [extraSubject]);
    await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
      nextLineage, restoredEvidence)).rejects.toThrow('Access state differs from recovery coverage');
    await restoredAccess.query('DELETE FROM access.authority_subject WHERE id = $1', [extraSubject]);
    // Inserting and deleting the fault also invalidates recommendations. Remove
    // that fixture side effect before testing an independent Account mismatch.
    await restoredAccess.query('DELETE FROM access.also_enjoyed_source_change WHERE id > $1', [lastChange]);
    expect((await accessStateTables(restoredAccess)).tables).toEqual(capturedAccess.tables);
    const originalName = (await restoredAccount.query<{ name: string }>(
      'SELECT name FROM public."user" WHERE id = $1', [member.id])).rows[0]?.name;
    if (!originalName) throw new Error('restored Account user is absent');
    await restoredAccount.query('UPDATE public."user" SET name = $1 WHERE id = $2',
      ['Wrong recovery cut', member.id]);
    await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
      nextLineage, restoredEvidence)).rejects.toThrow('Account rows differ from recovery coverage');
    await restoredAccount.query('UPDATE public."user" SET name = $1 WHERE id = $2',
      [originalName, member.id]);
    const extraCheckpoint = `mixed-cut-${randomUUID()}`;
    await restoredContent.query(`INSERT INTO content.projection_checkpoint
      (consumer, data_epoch, sequence) VALUES ($1, $2, 0)`,
    [extraCheckpoint, saved.position.dataEpoch]);
    await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
      nextLineage, restoredEvidence)).rejects.toThrow(
      'Content owner or graph references differ from recovery coverage');
    await restoredContent.query('DELETE FROM content.projection_checkpoint WHERE consumer = $1',
      [extraCheckpoint]);
    const trustedNote = (await restoredContent.query<{ signed_note: Buffer }>(
      "SELECT signed_note FROM pkg.go_sumdb_head WHERE server = 'sum.golang.org'"))
      .rows[0]?.signed_note;
    if (!trustedNote) throw new Error('restored Go checksum checkpoint is absent');
    await restoredContent.query("UPDATE pkg.go_sumdb_head SET signed_note = $1 WHERE server = 'sum.golang.org'",
      [Buffer.from('mixed package cut')]);
    await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
      nextLineage, restoredEvidence)).rejects.toThrow(
      'Content owner or graph references differ from recovery coverage');
    await restoredContent.query("UPDATE pkg.go_sumdb_head SET signed_note = $1 WHERE server = 'sum.golang.org'",
      [trustedNote]);
    // Simulate a mismatched immutable receipt only in the restored test copy.
    await restoredContent.query('ALTER TABLE pkg.npm_resolution DISABLE TRIGGER pkg_npm_resolution_immutable');
    try {
      await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1',
        [npmId, JSON.stringify({ ...npmReceipt.outcome, edges: [] })]);
      await expect(restoredNpm.read(principalId, npmId)).rejects.toBeInstanceOf(NpmResolutionUnavailable);
      await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
        nextLineage, restoredEvidence)).rejects.toThrow(
        'Content owner or graph references differ from recovery coverage');
      await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1',
        [npmId, JSON.stringify(npmReceipt.outcome)]);
      for (const { id, receipt } of npmPlatformReceipts) {
        await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1',
          [id, JSON.stringify({ ...receipt.outcome, omittedInstances: [] })]);
        await expect(restoredNpm.read(principalId, id)).rejects.toBeInstanceOf(NpmResolutionUnavailable);
        await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
          nextLineage, restoredEvidence)).rejects.toThrow('Content owner or graph references differ from recovery coverage');
        await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1',
          [id, JSON.stringify(receipt.outcome)]);
      }
      for (const { id, receipt, request } of npmIdentityReceipts) {
        const hasWorkspace = request.workspaces.length > 0;
        const corrupted = { ...receipt.outcome, instances: receipt.outcome.instances.map(node =>
          hasWorkspace && 'linkTarget' in node && node.linkTarget && typeof node.linkTarget === 'object'
            ? { ...node, linkTarget: { ...node.linkTarget, path: 'packages/wrong' } }
            : !hasWorkspace && node.path === 'node_modules/renamed' ? { ...node, name: 'wrong-package' } : node) };
        await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1', [id, JSON.stringify(corrupted)]);
        await expect(restoredNpm.read(principalId, id)).rejects.toBeInstanceOf(NpmResolutionUnavailable);
        await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
          nextLineage, restoredEvidence)).rejects.toThrow('Content owner or graph references differ from recovery coverage');
        await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1', [id, JSON.stringify(receipt.outcome)]);
      }
      for (const { id, receipt } of npmCompositionReceipts) {
        if (!('omittedEdges' in receipt.outcome)) throw new Error('composed recovery receipt lacks projection');
        const corruptions = [
          { ...receipt.outcome, instances: receipt.outcome.instances.map(node =>
            node.path === 'node_modules/renamed' ? { ...node, name: 'wrong-package' } : node) },
          { ...receipt.outcome, instances: receipt.outcome.instances.map(node =>
            'linkTarget' in node && node.linkTarget ? { ...node, linkTarget: { ...node.linkTarget, path: 'modules/wrong' } } : node) },
          ...(receipt.outcome.omittedEdges.length ? [{ ...receipt.outcome,
            omittedEdges: receipt.outcome.omittedEdges.map(edge => ({ ...edge, causePath: 'node_modules/wrong' })) }] : []),
        ];
        for (const corrupted of corruptions) {
          await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1', [id, JSON.stringify(corrupted)]);
          await expect(restoredNpm.read(principalId, id)).rejects.toBeInstanceOf(NpmResolutionUnavailable);
          await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
            nextLineage, restoredEvidence)).rejects.toThrow('Content owner or graph references differ from recovery coverage');
          await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1', [id, JSON.stringify(receipt.outcome)]);
        }
      }
      for (const { id, receipt } of npmPolicyReceipts) {
        if (!('overrideSelections' in receipt.outcome)) throw new Error('policy recovery receipt lacks override witness');
        const originalOutcome = (await restoredContent.query<{ outcome: unknown }>(
          'SELECT outcome FROM pkg.npm_resolution WHERE id = $1', [id])).rows[0]?.outcome;
        if (!originalOutcome) throw new Error('restored policy receipt is absent');
        for (const corrupted of [
          { ...receipt.outcome, overrideSelections: receipt.outcome.overrideSelections.map(item =>
            ({ ...item, effectiveSpecifier: '9.0.0' })) },
          { ...receipt.outcome, engineChecks: receipt.outcome.engineChecks.map(item =>
            ({ ...item, compatible: !item.compatible })) },
        ]) {
          await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1', [id, JSON.stringify(corrupted)]);
          await expect(restoredNpm.read(principalId, id)).rejects.toBeInstanceOf(NpmResolutionUnavailable);
          await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
            nextLineage, restoredEvidence)).rejects.toThrow('Content owner or graph references differ from recovery coverage');
          await restoredContent.query('UPDATE pkg.npm_resolution SET outcome = $2 WHERE id = $1', [id, JSON.stringify(originalOutcome)]);
        }
      }
    } finally {
      await restoredContent.query('ALTER TABLE pkg.npm_resolution ENABLE TRIGGER pkg_npm_resolution_immutable');
    }
    const retainedBatch = (await restoredRelay.query<{ batch_id: string;
      routing_epoch: string; event_count: number }>(
      'SELECT batch_id, routing_epoch, event_count FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence = 2',
      [lineage.dataEpoch])).rows[0];
    if (!retainedBatch) throw new Error('retained relay batch is absent');
    await restoredRelay.query('DELETE FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence = 2',
      [lineage.dataEpoch]);
    try {
      await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
        nextLineage, restoredEvidence)).rejects.toThrow(
          'relay checkpoint or delivered events are unavailable');
    } finally {
      await restoredRelay.query(`INSERT INTO relay.delivered_batch
        (data_epoch, sequence, batch_id, routing_epoch, event_count) VALUES ($1,2,$2,$3,$4)`,
      [lineage.dataEpoch, retainedBatch.batch_id, retainedBatch.routing_epoch,
        retainedBatch.event_count]);
    }
    const retainedReference = (await graphObjectReferences(fuseki))
      .find(reference => reference.graph === 'urn:rezics:graph:revisions');
    if (!retainedReference) throw new Error('retained graph manifest is absent');
    const retainedManifest = retainedReference.manifest;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA {
      GRAPH <urn:rezics:graph:revisions> {
        <${retainedReference.subject}> rv:manifest <${retainedManifest}> . } }`);
    try {
      await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
        nextLineage, restoredEvidence)).rejects.toThrow(
          'graph or immutable objects differ from recovery coverage');
    } finally {
      await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
        GRAPH <urn:rezics:graph:revisions> {
          <${retainedReference.subject}> rv:manifest <${retainedManifest}> . } }`);
    }
    const objectPath = join(env.objectDirectory, retainedManifest.slice(-64));
    const originalObject = readFileSync(objectPath);
    try {
      rmSync(objectPath);
      await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
        nextLineage, restoredEvidence)).rejects.toThrow(
          'graph or immutable objects differ from recovery coverage');
      const held = await restoreRequest(`mixed-object-${randomUUID()}`);
      expect(held.status).toBe(201);
      expect(await held.json()).toMatchObject({ kind: 'restore', state: 'held',
        disposition: 'unavailable' });
      writeFileSync(objectPath, Buffer.from('mixed object cut'));
      await expect(releaseRestoredGraphHold(fuseki, restoredAccess, restoredRelay,
        nextLineage, restoredEvidence)).rejects.toThrow(
          'graph or immutable objects differ from recovery coverage');
      const corruptHeld = await restoreRequest(`corrupt-object-${randomUUID()}`);
      expect(corruptHeld.status).toBe(201);
      expect(await corruptHeld.json()).toMatchObject({ kind: 'restore', state: 'held',
        disposition: 'corrupt' });
    } finally { writeFileSync(objectPath, originalObject); }
    const newerBody = Buffer.from('unreferenced newer immutable body');
    const newerDigest = createHash('sha256').update(newerBody).digest('hex');
    writeFileSync(join(env.objectDirectory, newerDigest), newerBody);
    const restoreKey = `matched-object-${randomUUID()}`;
    const released = await restoreRequest(restoreKey);
    expect(released.status).toBe(201);
    const releaseResult = await released.json() as { id: string; kind: string;
      state: string; disposition: string };
    expect(releaseResult).toMatchObject({ kind: 'restore', state: 'reconciled',
      disposition: 'matched' });
    expect((await restoreRequest(restoreKey)).status).toBe(200);
    const cuts = await restoredRelay.query<{ owner: string; status: string }>(
      `SELECT owner, status FROM relay.owner_reconciliation_cut WHERE reconciliation_id = $1`,
      [releaseResult.id]);
    expect(cuts.rows).toEqual(expect.arrayContaining(['account', 'access', 'content',
      'graph', 'object', 'relay'].map(owner => ({ owner, status: 'matched' }))));
    await releaseAccessRecoveryFence(restoredAccess, fenceGeneration);
    expect((await accessPool.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]?.open).toBe(false);
    await accountApp.stop();
    accountApp = createAccountApp(createAccountAuth({ ...accountConfig,
      pool: restoredAccount }), restoredAccount).listen({ hostname: '127.0.0.1', port });
    expect(await account.verify(request, ['work:create']))
      .toEqual({ ...principal, currentAssertion: expect.any(Function) });
    const releasedApp = createMainApp(fuseki, { environment: heldEnv,
      account, access: new AccessAdmissionRegistry(restoredAccess),
      content: new ContentCore(restoredContent), contentAuthoring: new ContentCore(restoredContent) });
    expect((await releasedApp.handle(new Request('http://localhost/health/ready'))).status).toBe(200);
  } finally {
    try {
      await accountApp?.stop();
      await Promise.allSettled(pools.map(pool => pool.end()));
      if (restoredStartAttempted && spawnSync('pg_ctl', ['-D', restoredData, 'status'],
        { cwd: state, timeout: 5_000 }).status === 0) {
        execFileSync('pg_ctl', ['-D', restoredData,
          '-m', 'immediate', '-t', '10', '-w', 'stop'], { cwd: state, timeout: 15_000 });
      }
    } finally {
      try { if (started) rootCommand(['stack:reset', ...stackArgs], 120_000); }
      finally { rmSync(state, { recursive: true, force: true }); }
    }
  }
}, 240_000);
