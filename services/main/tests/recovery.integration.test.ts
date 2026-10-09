import { qaStartupTestTimeout, runQaStartupChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { withQaStackStartup } from '../../../scripts/qa/memory-admission.ts';
import { composeProcessEnvironment, projectName, readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { test, expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync,
  mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { decodeJwt } from 'jose';
import { getMigrations } from 'better-auth/db/migration';
import { accountAuthOptions, createAccountAuth } from '../../account/src/auth.ts';
import { createAccountApp } from '../../account/src/app.ts';
import { installConsentRefreshFence } from '../../account/src/consent-fence.ts';
import { accountRecoveryCoverage } from '../../account/src/recovery-coverage.ts';
import { ContentCore } from '../../content/src/core.ts';
import { ContentComments } from '../../content/src/comments.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult } from '../src/infrastructure/fuseki.ts';
import { createMainApp } from '../src/app.ts';
import { AccessAdmissionRegistry, AdmissionDenied, engageAccessRecoveryFence,
  releaseAccessRecoveryFence } from '../src/modules/access/admission.ts';
import { createAdmittedMetadataWork } from '../src/modules/work/create-admitted.ts';
import { editAdmittedMetadataWork } from '../src/modules/work/edit-admitted.ts';
import { createAdmittedTextContribution } from '../src/modules/contribution/create-admitted.ts';
import { editAdmittedTextContribution } from '../src/modules/contribution/edit-admitted.ts';
import { publishAdmittedTextContribution } from '../src/modules/contribution/publish-admitted.ts';
import { selectAdmittedMainDefault } from '../src/modules/work/select-main-admitted.ts';
import { selectAdmittedRealmLocal } from '../src/modules/work/select-realm-admitted.ts';
import { rejectAdmittedRealmLocal } from '../src/modules/work/reject-realm-admitted.ts';
import { realmRejectionDigest, sealRealmRejectionAdmission,
  StaleRealmRejection } from '../src/modules/work/reject-realm.ts';
import { realmSelectionDigest, sealRealmSelectionAdmission,
  StaleRealmSelection } from '../src/modules/work/select-realm.ts';
import { createAdmittedRealmSpace } from '../src/modules/space/create-admitted.ts';
import { readSpaceCreationReceipt, sealRealmSpaceAdmission,
  spaceCreationDigest } from '../src/modules/space/create.ts';
import { createAdmittedClassificationContext } from '../src/modules/classification/context-admitted.ts';
import { classificationContextDigest, readClassificationContextReceipt,
  sealClassificationContextAdmission } from '../src/modules/classification/context.ts';
import { createAdmittedClassificationProposition } from '../src/modules/classification/proposition-admitted.ts';
import { classificationPropositionDigest, readClassificationPropositionReceipt,
  sealClassificationPropositionAdmission } from '../src/modules/classification/proposition.ts';
import { setAdmittedClassificationDecision } from '../src/modules/classification/decision-admitted.ts';
import { classificationDecisionDigest, readClassificationDecisionReceipt,
  sealClassificationDecisionAdmission } from '../src/modules/classification/decision.ts';
import { createAdmittedRatingContext } from '../src/modules/rating/context-admitted.ts';
import { ratingContextDigest, readRatingContextReceipt,
  sealRatingContextAdmission } from '../src/modules/rating/context.ts';
import { setAdmittedStandingRating } from '../src/modules/rating/observation-admitted.ts';
import { readStandingRatingReceipt, sealStandingRatingAdmission,
  standingRatingDigest } from '../src/modules/rating/observation.ts';
import { queryStandingRatingAggregate } from '../src/modules/rating/aggregate.ts';
import { mainSelectionDigest, sealMainSelectionAdmission,
  StaleMainSelection } from '../src/modules/work/select-main.ts';
import { queryPublicMainClassifiedPhrase, queryPublicMainPhrase,
  queryPublicRealmClassifiedPhrase, queryPublicRealmPhrase } from '../src/modules/work/search-public.ts';
import { queryPublicRealmClassifiedRatedPhrase } from '../src/modules/work/search-joined.ts';
import { sealTextPublicationAdmission, StalePublicationHead,
  textPublicationDigest } from '../src/modules/contribution/publish.ts';
import { readExactContributionDraft } from '../src/modules/contribution/history.ts';
import { sealTextContributionAdmission, textContributionDigest } from '../src/modules/contribution/draft.ts';
import { sealTextContributionEditAdmission, StaleContributionDraftHead,
  textContributionEditDigest } from '../src/modules/contribution/edit.ts';
import { editMetadataWork, metadataWorkEditDigest, StaleWorkHead } from '../src/modules/work/edit.ts';
import { sealMetadataWorkAdmission } from '../src/modules/work/seal.ts';
import { readExactWorkRevision, RevisionUnavailable } from '../src/modules/work/history.ts';
import { reconcileRetainedAdmissionCancellation, reconcileRetainedContributionDraftCreate,
  reconcileRetainedContributionDraftEdit, reconcileRetainedContributionPublication,
  reconcileRetainedMainSelection,
  reconcileRetainedRealmSelection,
  reconcileRetainedRealmRejection,
  reconcileRetainedRealmSpaceCreate,
  reconcileRetainedClassificationContext,
  reconcileRetainedClassificationProposition,
  reconcileRetainedClassificationDecision,
  reconcileRetainedRatingContext,
  reconcileRetainedStandingRating,
  reconcileRetainedEmptyBatch, reconcileRetainedWorkCancellation,
  reconcileRetainedWorkCreate, reconcileRetainedWorkEdit,
  RetainedEffectConflict } from '../src/modules/work/reconcile-restored.ts';
import { CancelledActivation, initializeFreshGraph, metadataWorkRequestDigest,
  PendingActivation, type GraphLineage, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { accessOutboxCoverage, accessStateCoverage, captureGraphRecoveryCoverage,
  cutoverRestoredGraphLineage,
  RecoveryHold, releaseRestoredGraphHold, type AuthenticatedRecoveryCoverage, type RecoveryCoverage,
  type DeletionReleaseEvidence,
  RestoreLineageConflict } from '../src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { retainRecoveryCoverageHead } from '../src/modules/outbox/recovery-coverage-head.ts';
import { captureObjectRecoveryCoverage } from '../src/modules/owner/object-coverage.ts';
import { reconcileRestoredErasures, releaseErasureRestoreHold } from '../src/modules/erasure/reconcile.ts';
import { heldErasureMaintenanceClient } from '../src/modules/erasure/graph.ts';
import { openRecoveryPayload, sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'ab'.repeat(32);

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('OPS03/SYS13/BOOK04/IAM21 partial: real OAuth across isolated Account, Access, Content and graph restore', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the fault/recovery QA tier');
  const runId = `recovery-${Bun.randomUUIDv7().slice(0, 18)}`;
  const options = { profile: 'qa' as const, runId, persistent: true, rawUpdate: true };
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent', '--raw-update'];
  const project = projectName(options);
  const directory = stackDirectory(root, options);
  const dockerEnv = loadDockerEnvironment();
  const docker = (args: string[], timeout = 120_000) => execFileSync('docker', args,
    { cwd: root, env: dockerEnv, encoding: 'utf8', timeout, maxBuffer: 10_000_000 });
  const dockerLogs = (name: string) => {
    const result = spawnSync('docker', ['logs', name],
      { cwd: root, env: dockerEnv, encoding: 'utf8', timeout: 10_000, maxBuffer: 10_000_000 });
    return `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
  };
  const compose = (args: string[], timeout = 120_000) => execFileSync('docker', [
    'compose', '--env-file', join(directory, 'compose.env'),
    '-f', join(root, 'infra/dev/compose.yaml'),
    '-f', join(root, 'infra/dev/compose.qa-raw-update.yaml'),
    '--project-name', project, ...args], { cwd: root,
      env: composeProcessEnvironment(dockerEnv, readEnv(join(directory, 'compose.env'))),
      encoding: 'utf8', timeout, maxBuffer: 10_000_000 });
  const state = join(root, '.temp', `work-recovery-${Bun.randomUUIDv7()}`);
  const liveBase = join(state, 'live', 'run');
  const savedBase = join(state, 'saved-cut', 'run');
  const savedObjects = join(state, 'saved-cut', 'objects');
  const savedPg = join(state, 'saved-cut', 'pgdata');
  const restoreBase = join(state, 'restore', 'run');
  const liveObjects = join(state, 'live', 'objects');
  const restoreObjects = join(state, 'restore', 'objects');
  const livePg = join(state, 'live', 'pgdata');
  const restorePg = join(state, 'restore', 'pgdata');
  const accountPg = join(state, 'account', 'pgdata');
  const accountBackup = join(state, 'account', 'base-backup');
  const accountArchive = join(state, 'account', 'wal-archive');
  const accountRestoredPg = join(state, 'account', 'restored');
  const contentPg = join(state, 'content', 'pgdata');
  const contentRestoredPg = join(state, 'content', 'restored');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const restoredContainers = new Set<string>();
  const restoredPorts = new Map<string, number>();
  const pools: Pool[] = [];
  let saved: Record<string, string>;
  let sourcePostgres: string;
  let sourceFuseki: string;
  let postgresImage: string;
  let graphUrl: string;
  let started = false;
  const sourceUrl = (owner: string) => `postgres://postgres:${encodeURIComponent(saved.POSTGRES_PASSWORD!)}@127.0.0.1:${saved.POSTGRES_PORT}/${owner}`;
  const poolAt = (owner: string, port = saved.POSTGRES_PORT!) => {
    const url = new URL(sourceUrl(owner));
    url.port = String(port);
    const pool = new Pool({ connectionString: url.toString() });
    pools.push(pool);
    return { pool, url: url.toString() };
  };
  const admissionEnv = () => ({ ...dockerEnv, ...saved, REZICS_QA_MEMORY_EVENTS: '1',
    REZICS_POSTGRES_MEMORY_LIMIT: '512m' });
  const stopFuseki = async () => { compose(['stop', 'fuseki'], 65_000); };
  const saveGraph = (destination: string) => {
    mkdirSync(destination, { recursive: true });
    // The stopped owner has flushed both TDB2 and its Lucene commit.
    docker(['cp', `${sourceFuseki}:/fuseki/databases/rezics`, destination]);
  };
  const startFuseki = async (base: string, label: string) => {
    if (label !== 'live') {
      docker(['run', '--rm', '--network', 'none', '--user', '0:0',
        '--volume', `${base}:/from:ro`, '--volume', `${project}_fuseki_data:/to`,
        '--entrypoint', 'sh', postgresImage, '-ec',
        'find /to -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; cp -a /from/. /to/; chown -R 10001:10001 /to/rezics']);
      await withQaStackStartup(root, admissionEnv(), undefined,
        () => compose(['up', '-d', '--wait', 'fuseki'], 90_000), { services: ['fuseki'] });
    }
    const fuseki = new FusekiClient(graphUrl, saved.FUSEKI_MAINTENANCE_TOKEN,
      saved.FUSEKI_COMMAND_TOKEN);
    expect((await fuseki.query('ASK {}')).boolean).toBe(true);
    return { fuseki, url: graphUrl };
  };
  const backupPg = (destination: string) => {
    const remote = `/var/lib/postgresql/.temp/recovery-${Bun.randomUUIDv7()}`;
    try {
      docker(['exec', '-u', 'postgres', sourcePostgres, 'sh', '-ec',
        `mkdir -p /var/lib/postgresql/.temp
PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -p 5432 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast
pg_verifybackup --no-parse-wal ${remote}`], 100_000);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      docker(['cp', `${sourcePostgres}:${remote}`, destination]);
    } finally {
      docker(['exec', '-u', 'postgres', sourcePostgres, 'rm', '-rf', remote], 10_000);
    }
  };
  const startPg = async (data: string, label: string) => {
    const owner = label.startsWith('account') ? 'account'
      : label.startsWith('content') ? 'content' : label === 'journal' ? 'relay' : 'access';
    if (data === livePg || data === accountPg || data === contentPg || label === 'journal') {
      return { ...poolAt(owner), data };
    }
    // Access and Content share the saved physical owner cut. Closing one pool
    // never stops the other owner's retained restored timeline.
    const restoredData = data === contentRestoredPg ? restorePg : data;
    let port = restoredPorts.get(restoredData);
    if (!port) {
      port = await freePort();
      const name = `${project}-${label}`;
      const archivedAccount = data === accountRestoredPg;
      const mounts = ['--volume', `${restoredData}:/recovery/data`,
        ...(archivedAccount ? ['--volume', `${accountArchive}:/recovery/archive:ro`] : [])];
      restoredContainers.add(name);
      await withQaStackStartup(root, admissionEnv(), undefined, async () => {
        // PostgreSQL in the pinned image owns its writable copy; no host server
        // or separately installed PostgreSQL/Jena runtime participates.
        docker(['run', '--rm', '--network', 'none', '--user', '0:0',
          '--volume', `${restoredData}:/recovery/data`,
          ...(archivedAccount ? ['--volume', `${accountArchive}:/recovery/archive`] : []),
          '--entrypoint', 'sh', postgresImage, '-ec',
          `chown -R postgres:postgres /recovery/data${archivedAccount ? ' /recovery/archive' : ''}; chmod 700 /recovery/data`]);
        docker(['run', '-d', '--name', name, '--memory', '512m',
          '--label', `com.docker.compose.project=${project}`,
          '--label', `com.docker.compose.service=${label}`,
          '--label', 'com.docker.compose.oneoff=False',
          '--publish', `127.0.0.1:${port}:5432`, '--user', 'postgres', ...mounts,
          '--entrypoint', 'postgres', postgresImage, '-D', '/recovery/data',
          '-c', 'listen_addresses=*', '-c', 'port=5432',
          '-c', 'unix_socket_directories=/tmp', '-c', 'archive_mode=off']);
        const probe = poolAt(owner, String(port));
        try {
          for (let attempt = 0; attempt < 120; attempt++) {
            try { await probe.pool.query('SELECT 1'); break; }
            catch (error) {
              if (attempt === 119) throw new Error(`Restored PostgreSQL did not start: ${dockerLogs(name)}`, { cause: error });
              await Bun.sleep(250);
            }
          }
        } finally { await probe.pool.end(); }
      }, { services: ['postgres'] });
      restoredPorts.set(restoredData, port);
    }
    return { ...poolAt(owner, String(port)), data };
  };
  let graph: Awaited<ReturnType<typeof startFuseki>> | undefined;
  let database: Awaited<ReturnType<typeof startPg>> | undefined;
  let journal: Awaited<ReturnType<typeof startPg>> | undefined;
  let accountDatabase: Awaited<ReturnType<typeof startPg>> | undefined;
  let accountRestoredDatabase: Awaited<ReturnType<typeof startPg>> | undefined;
  let contentDatabase: Awaited<ReturnType<typeof startPg>> | undefined;
  let accountApp: ReturnType<typeof createAccountApp> | undefined;
  let latestAccess: Awaited<ReturnType<typeof startPg>> | undefined;
  try {
    started = true;
    const startup = await runQaStartupChildAsync(root, ['stack:up', ...stackArgs], 180_000);
    if (!startup.ok) throw new Error(`Recovery QA stack did not start: ${startup.output.slice(-4000)}`);
    saved = readEnv(join(directory, 'compose.env'));
    sourcePostgres = compose(['ps', '-q', 'postgres']).trim();
    sourceFuseki = compose(['ps', '-q', 'fuseki']).trim();
    postgresImage = docker(['inspect', '--format', '{{.Config.Image}}', sourcePostgres]).trim();
    graphUrl = readEnv(join(directory, 'apps.env')).FUSEKI_URL!;
    process.env.FUSEKI_MAINTENANCE_TOKEN = saved.FUSEKI_MAINTENANCE_TOKEN;
    process.env.FUSEKI_COMMAND_TOKEN = saved.FUSEKI_COMMAND_TOKEN;
    graph = await startFuseki(liveBase, 'live');
    database = await startPg(livePg, 'live');
    journal = await startPg('', 'journal');
    accountDatabase = await startPg(accountPg, 'account');
    const accountPool = accountDatabase.pool;
    const accountPort = await freePort();
    const accountBase = `http://127.0.0.1:${accountPort}`;
    const accountOperators = new Set<string>();
    const accountConfig = (accountOwnerPool: Pool) => ({
      baseURL: accountBase, secret: 'recovery-fixture-account-secret-value-32',
      resource: 'https://main.rezics.test', pool: accountOwnerPool,
      operatorUserIds: accountOperators, accessDeletionFence: async () => {},
    });
    await (await getMigrations(accountAuthOptions(accountConfig(accountPool)))).runMigrations();
    await installConsentRefreshFence(accountPool);
    const accountAuth = createAccountAuth(accountConfig(accountPool));
    accountApp = createAccountApp(accountAuth, accountPool)
      .listen({ hostname: '127.0.0.1', port: accountPort });
    contentDatabase = await startPg(contentPg, 'content');
    const contentPool = contentDatabase.pool;
    let fuseki = graph.fuseki;
    let pool = database.pool;
    const relayMigrations = join(root, 'services/main/migrations/relay');
    for (const file of schemaFiles(root, 'relay')) {
      await journal.pool.query(readFileSync(join(relayMigrations, file), 'utf8'));
    }
    const accessMigrations = join(root, 'services/main/migrations/access');
    for (const file of schemaFiles(root, 'access')) {
      await pool.query(readFileSync(join(accessMigrations, file), 'utf8'));
    }
    await migrateContent(contentPool);
    // Build each owner's schema once; the older Account cut still precedes
    // every signup and OAuth fixture recovered from the retained WAL archive.
    backupPg(accountBackup);
    const principalId = Bun.randomUUIDv7();
    const actor = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const signUp = async (name: string) => {
      const email = `${name}-${Bun.randomUUIDv7()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${accountBase}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: accountBase },
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    accountOperators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: accountBase });
    const verifierClient = await accountAuth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Recovery Main verifier', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    const oauthScope = 'openid work:create work:edit work:read comment:create space:create'
      + ' realm:adopt realm:reject realm:classify classification:define classification:decide'
      + ' rating:configure rating:submit';
    const redirectUri = 'http://localhost:3000/auth/callback';
    const browserClient = await accountAuth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Recovery browser', application_type: 'native',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
        scope: oauthScope, skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const signedIn = await fetch(`${accountBase}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: accountBase },
      body: JSON.stringify({ email: member.email, password: member.password }),
    });
    expect(signedIn.status).toBe(200);
    const accessToken = (await signIn({
      account: accountBase, clientId: browserClient.client_id, redirectUri,
      scope: oauthScope, resource: accountConfig(accountPool).resource,
    }, signedIn.headers.get('set-cookie')!)).accessToken;
    let bearer = `Bearer ${accessToken}`;
    const metadataResponse = await fetch(`${accountBase}/api/auth/.well-known/openid-configuration`);
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json() as { issuer: string; jwks_uri: string };
    const principal = { issuer: metadata.issuer, subject: member.id };
    const expectedAccountAssertion = {
      ...principal,
      accountExpiresAt: decodeJwt(accessToken).exp,
      accountAuthMode: 'trusted',
      accountClientId: browserClient.client_id,
      accountConsentId: undefined,
      accountConsentGeneration: undefined,
      accountAudiences: [accountConfig(accountPool).resource, `${accountBase}/api/auth/oauth2/userinfo`],
      accountScopes: oauthScope.split(' '),
      contentEvidence: undefined,
      currentAssertion: expect.any(Function),
    };
    await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT (id) DO NOTHING");
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    for (const action of ['work.create', 'work.edit', 'work.read']) {
      await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [Bun.randomUUIDv7(), principalId, actor, action]);
    }
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '1 hour')`, [Bun.randomUUIDv7(), actor]);
    const account = new AccountAssertionVerifier({ issuer: metadata.issuer,
      audience: accountConfig(accountPool).resource, jwksUrl: metadata.jwks_uri,
      introspectUrl: `${accountBase}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    const request = new Request('https://main.rezics.test/v1/works', {
      method: 'POST', headers: { authorization: bearer },
    });
    expect(await account.verify(request, ['work:create'])).toEqual(expectedAccountAssertion);
    const oldLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '1' };
    const liveEnv: WorkActivationEnvironment = { fuseki, lineage: oldLineage,
      objectDirectory: liveObjects, candidateDirectory: join(state, 'live', 'candidates'),
      repositoryRoot: root };
    await initializeFreshGraph(fuseki, oldLineage);
    // The replay goes through own-work authoring. Seed its native author without
    // advancing the exact Work/outbox positions this recovery cut qualifies.
    const authorRevision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:current> { <${actor}> a rv:Agent ; rv:head <${authorRevision}> . }
      GRAPH <urn:rezics:graph:revisions> { <${authorRevision}> a rv:RevisionAnchor ; rv:component <${actor}> . }
    }`);
    await initializeRelayCheckpoint(journal.pool, 'recovery-handoff', oldLineage.dataEpoch);
    let access = new AccessAdmissionRegistry(pool);
    const createInput = { actingSubject: actor, authorAgent: actor,
      idempotencyKey: 'before-backup-create', title: 'Backup Work', language: 'en' };
    const created = await createAdmittedMetadataWork(liveEnv, account, access, request, createInput);
    expect(created.sequence).toBe('1');
    const workApiRequest = () => new Request('http://localhost/v1/works', {
      method: 'POST', headers: { authorization: bearer,
        'content-type': 'application/json', 'idempotency-key': createInput.idempotencyKey },
      body: JSON.stringify({ profile: 'metadata-only-v1', authoring: 'own-work',
        title: createInput.title, language: createInput.language,
        actingSubject: actor }),
    });
    const liveWorkReplay = await createMainApp(fuseki, { environment: liveEnv,
      account, access }).handle(workApiRequest());
    expect(liveWorkReplay.status).toBe(200);
    expect(await liveWorkReplay.json()).toMatchObject({ work: created.work,
      workRevision: created.workRevision, replayed: true });
    const readScope = `work:read:${created.work}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [readScope]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.read', now() + interval '1 hour')`, [Bun.randomUUIDv7(), actor, readScope]);
    const editScope = `work:edit:${created.work}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [editScope]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.edit', now() + interval '1 hour')`, [Bun.randomUUIDv7(), actor, editScope]);
    const editInput = { work: created.work, expectedHead: created.workRevision,
      title: 'Backup edited Work', actingSubject: actor, idempotencyKey: 'before-backup-edit' };
    const edited = await editAdmittedMetadataWork(liveEnv, account, access, request, editInput);
    expect(edited.sequence).toBe('2');
    const content = new ContentCore(contentPool);
    const comments = new ContentComments(contentPool);
    const grantContent = async (scope: string, action: string) => {
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await pool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), principalId, actor, action]);
      await pool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), actor, scope, action]);
    };
    await grantContent(`content:draft:${created.work}`, 'content.draft');
    await grantContent(`content:comment:${created.work}`, 'content.comment');
    const liveApp = createMainApp(fuseki, { environment: liveEnv, account, access,
      content, contentAuthoring: content, comments });
    const variantId = `urn:rezics:variant:${Bun.randomUUIDv7()}`;
    const exactParagraph = 'Retained paragraph before graph restore';
    const draftBody = `Opening paragraph\n${exactParagraph}\nClosing paragraph`;
    const draftRequest = (body: string, expectedHead: string | null, key: string) =>
      new Request('http://localhost/v1/content-drafts', {
        method: 'POST', headers: { authorization: bearer,
          'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ profile: 'content-text-v1', resourceId: created.work,
          variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
          direction: 'ltr', expectedHead, body, actingSubject: actor }),
      });
    const firstDraftResponse = await liveApp.handle(draftRequest(draftBody, null, 'recovery-content-first'));
    expect(firstDraftResponse.status).toBe(201);
    const firstDraft = await firstDraftResponse.json() as { revisionId: string };
    const commentRequest = (body = 'A retained annotation', key = 'recovery-content-comment') =>
      new Request('http://localhost/v1/content-comments', {
        method: 'POST', headers: { authorization: bearer,
          'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ profile: 'content-paragraph-comment-v1',
          resourceId: created.work, revisionId: firstDraft.revisionId,
          exact: exactParagraph, body, actingSubject: actor }),
      });
    const createdCommentResponse = await liveApp.handle(commentRequest());
    expect(createdCommentResponse.status).toBe(201);
    const createdComment = await createdCommentResponse.json() as { comment: string;
      revisionId: string; target: { selector: { exact: string } } };
    expect(createdComment).toMatchObject({ revisionId: firstDraft.revisionId,
      target: { selector: { exact: exactParagraph } } });
    const secondDraftResponse = await liveApp.handle(draftRequest(
      'Replacement paragraph after the annotation', firstDraft.revisionId,
      'recovery-content-second'));
    expect(secondDraftResponse.status).toBe(201);
    const secondDraft = await secondDraftResponse.json() as { predecessor: string };
    expect(secondDraft.predecessor).toBe(firstDraft.revisionId);
    const commentReadRequest = () => new Request(
      `http://localhost/v1/content-comments/${createdComment.comment.split('/').at(-1)}`
        + `?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: bearer } });
    const contentReadRequest = () => new Request(
      `http://localhost/v1/content-revisions/${firstDraft.revisionId}`
        + `?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: bearer } });
    const commentListRequest = () => new Request(
      `http://localhost/v1/content-revisions/${firstDraft.revisionId}/comments`
        + `?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: bearer } });
    expect((await liveApp.handle(commentReadRequest())).status).toBe(200);
    const originalComments = await liveApp.handle(commentListRequest());
    expect(originalComments.status).toBe(200);
    expect(await originalComments.json()).toMatchObject({
      comments: [{ comment: createdComment.comment, resolvedText: exactParagraph }], next: null });
    const secondCommentResponse = await liveApp.handle(commentRequest(
      'Second retained annotation', 'recovery-content-comment-two'));
    expect(secondCommentResponse.status).toBe(201);
    const secondComment = await secondCommentResponse.json() as { comment: string };
    const commentPageRequest = (cursor?: string) => {
      const url = new URL(`http://localhost/v1/content-revisions/${firstDraft.revisionId}/comments`);
      url.searchParams.set('actingSubject', actor);
      url.searchParams.set('pageSize', '1');
      if (cursor) url.searchParams.set('cursor', cursor);
      return new Request(url.toString(), { headers: { authorization: bearer } });
    };
    const firstPageResponse = await liveApp.handle(commentPageRequest());
    expect(firstPageResponse.status).toBe(200);
    const firstPage = await firstPageResponse.json() as { comments: Array<{ comment: string }>;
      next: string | null };
    expect(firstPage.comments).toMatchObject([{ comment: createdComment.comment }]);
    expect(firstPage.next).toBeTruthy();
    const afterCutResponse = await liveApp.handle(commentRequest(
      'After page cut annotation', 'recovery-content-comment-after-cut'));
    expect(afterCutResponse.status).toBe(201);
    const afterCutComment = await afterCutResponse.json() as { comment: string };
    const secondPageBeforeRestore = await liveApp.handle(commentPageRequest(firstPage.next!));
    expect(secondPageBeforeRestore.status).toBe(200);
    expect(await secondPageBeforeRestore.json()).toMatchObject({
      comments: [{ comment: secondComment.comment, resolvedText: exactParagraph }], next: null });
    const retainedBody = (await content.readExactBatch([firstDraft.revisionId],
      async ids => new Set(ids)))[0];
    if (retainedBody?.status !== 'available') throw new Error('retained Content revision is unavailable');
    const retainedPreparation = await content.preparePublication('recovery-content-prepare',
      firstDraft.revisionId, retainedBody.reference.byteDigest);
    // Fixture-only raw graph reference preserves the existing graph command sequence while
    // exercising the exact Content cut gate in the isolated restore.
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:revisions> {
        <urn:rezics:fixture:content-recovery-reference> rv:contentRevision
          <urn:rezics:content:revision:${firstDraft.revisionId}> ;
          rv:contentPreparation "${retainedPreparation.operationId}" ;
          rv:byteDigest "${retainedBody.reference.byteDigest}" ;
          rv:ownerDataEpoch "${retainedPreparation.position.dataEpoch}" ;
          rv:ownerSequence "${retainedPreparation.position.sequence}" .
      }
    }`);
    const contentCut = await content.ownerPosition();
    const externalAccessOutbox = await accessOutboxCoverage(pool);
    const externalAccount = await accountRecoveryCoverage(accountPool);
    await expect(captureGraphRecoveryCoverage(fuseki, accountPool, pool, journal.pool,
      'recovery-handoff', contentPool)).rejects.toThrow('Access recovery fence must be held for capture');
    const accessUrl = database.url;
    const fenceCli = join(root, 'services/main/src/access-capture-fence.ts');
    const captureFence = JSON.parse(execFileSync(process.execPath, [fenceCli, 'hold'], {
      cwd: root, env: { ...process.env, ACCESS_RECOVERY_DATABASE_URL: accessUrl },
      encoding: 'utf8',
    })) as { generation: string };
    // Holding Access appends discovery authority history. Capture the held cut
    // before the reversible mutation probe so its signed state stays exact.
    const externalAccessState = await accessStateCoverage(pool);
    await expect(captureGraphRecoveryCoverage(fuseki, accountPool, pool, journal.pool,
      'recovery-handoff', contentPool)).rejects.toThrow('source graph or relay moved during recovery capture');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('1');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('2');
    // Principal updates advance immutable authority history. An unrelated
    // scope row changes the complete owner scan and can be removed exactly;
    // it never enters the work:read scope triggers' ranking populations.
    const racingScope = `fixture:capture:${Bun.randomUUIDv7()}`;
    class AccessMutationDuringCapture extends FusekiClient {
      private controlReads = 0;
      override async query(sparql: string) {
        const result = await super.query(sparql);
        if (sparql.includes('SELECT ?epoch ?routing ?sequence') && ++this.controlReads === 2) {
          await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [racingScope]);
        }
        return result;
      }
    }
    try {
      await expect(captureGraphRecoveryCoverage(
        new AccessMutationDuringCapture(graph.url),
        accountPool, pool, journal.pool, 'recovery-handoff', contentPool))
        .rejects.toThrow('owner or graph moved during recovery capture');
    } finally {
      await pool.query('DELETE FROM access.scope_gate WHERE id = $1', [racingScope]);
    }
    const externalRelay = await relayCoverage(journal.pool, 'recovery-handoff');
    let capturedCoverage = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        capturedCoverage = execFileSync(process.execPath,
          [join(root, 'services/main/src/graph-recovery-coverage.ts'), 'capture'], {
            cwd: root, env: { ...process.env,
              FUSEKI_URL: graph.url,
              ACCOUNT_RECOVERY_DATABASE_URL: accountDatabase.url,
              ACCESS_RECOVERY_DATABASE_URL: accessUrl,
              RELAY_RECOVERY_DATABASE_URL: journal.url,
              CONTENT_RECOVERY_DATABASE_URL: contentDatabase.url,
              MAIN_OBJECT_DIRECTORY: liveObjects,
              RELAY_CONSUMER: 'recovery-handoff', RECOVERY_MANIFEST_HMAC_KEY: recoveryKey },
            encoding: 'utf8',
          });
        break;
      } catch (error) {
        const diagnostic = String((error as { stderr?: string | Buffer }).stderr ?? error);
        if (!diagnostic.includes('owner or graph moved during recovery capture: Account WAL frontier')
          || attempt === 4) throw error;
        // The disposable Account cluster may finish flushing prior setup WAL.
        // Each capture still requires two matching full owner scans.
        await Bun.sleep(200);
      }
    }
    const currentCoverage = openRecoveryPayload<RecoveryCoverage>(capturedCoverage,
      recoveryKey, 'graph-recovery-coverage');
    expect((await journal.pool.query<{ generation: string }>(
      'SELECT generation FROM relay.recovery_coverage_head WHERE consumer = $1',
      ['recovery-handoff'])).rows[0]?.generation).toBe('1');
    expect(currentCoverage.accountPg.systemIdentifier).toMatch(/^[0-9]+$/);
    expect(currentCoverage.content).toMatchObject({
      dataEpoch: contentCut.dataEpoch, sequence: contentCut.sequence,
      graphReferencesCount: '1',
    });
    expect(currentCoverage).toMatchObject({
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      account: externalAccount,
      accessOutboxCount: externalAccessOutbox.count,
      accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count,
      accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    });
    let releaseAccountPool = accountPool;
    let laterObjects: RecoveryCoverage['objects'];
    const releaseEvidence = (
      graphClient: FusekiClient, accessPool: Pool, relayPool: Pool, lineage: GraphLineage,
      sealedCoverage: string, objectDirectory: string, contentOwner = contentDatabase?.pool,
    ): AuthenticatedRecoveryCoverage => {
      const authority = { sealedCoverage, hmacKey: recoveryKey };
      const objects = { directory: objectDirectory };
      return { ...authority, accountPool: releaseAccountPool, contentPool: contentOwner,
        objectStore: objects,
        releaseErasures: async (clients, releaseGraph) => {
          const marker = `urn:rezics:restore:${lineage.dataEpoch}`;
          const savedCut = (await graphClient.query(`PREFIX rv: <https://rezics.com/vocab/>
            SELECT ?priorDataEpoch ?priorSequence WHERE { GRAPH <urn:rezics:graph:control> {
              <${marker}> rv:priorDataEpoch ?priorDataEpoch ; rv:priorSequence ?priorSequence .
            } }`)).results?.bindings;
          if (savedCut?.length !== 1) throw new Error('Saved erasure restore cut is unavailable');
          const owners = { access: accessPool, account: releaseAccountPool, content: contentOwner!, objects,
            graph: { fuseki: graphClient, lineage,
              heldErasure: { originalSource: 'retained-native-event' as const,
                cut: { ...lineage, restoreCutover: marker,
                  priorDataEpoch: savedCut[0]!.priorDataEpoch!.value,
                  priorSequence: savedCut[0]!.priorSequence!.value },
                accessHoldGeneration: clients.fenceGeneration,
                signingKey: saved.FUSEKI_TITLE_ADMISSION_KEY!,
                maintenance: heldErasureMaintenanceClient(graphUrl, saved.FUSEKI_MAINTENANCE_TOKEN!),
              },
            },
          };
          const reconciled = await reconcileRestoredErasures(relayPool, owners, {
            operationId: `recovery-release:${Bun.randomUUIDv7()}`, consumer: 'recovery-handoff',
            replay: true, authority,
          }, clients);
          if (reconciled.state !== 'reconciled') {
            throw new Error(`Retained erasure restore is held: ${reconciled.holdReason}`);
          }
          await releaseErasureRestoreHold(relayPool, owners, reconciled.reconciliationId,
            clients.fenceGeneration, authority, { clients, beforeAccessRelease: releaseGraph });
        },
      };
    };
    const releaseGraphHold = async (
      graphClient: FusekiClient, accessPool: Pool, relayPool: Pool, lineage: GraphLineage,
      coverage: Omit<RecoveryCoverage, 'account' | 'accountPg' | 'commerce'>,
      deletions?: DeletionReleaseEvidence,
    ): Promise<void> => {
      const sealedCoverage = JSON.stringify(sealRecoveryPayload(
          { ...coverage, accountPg: currentCoverage.accountPg,
            account: externalAccount,
            commerce: currentCoverage.commerce,
            objects: coverage.priorSequence === '40' ? laterObjects : currentCoverage.objects,
            ...(currentCoverage.content ? { content: currentCoverage.content } : {}) },
          recoveryKey, 'graph-recovery-coverage'));
      await releaseRestoredGraphHold(graphClient, accessPool, relayPool, lineage, {
        ...releaseEvidence(graphClient, accessPool, relayPool, lineage, sealedCoverage,
          coverage.priorSequence === '40' ? liveObjects : restoreObjects), deletions,
      });
    };
    await accountPool.query('SELECT pg_switch_wal()');
    const accountWalArchived = () => {
      try { docker(['exec', sourcePostgres, 'test', '-f', `/var/lib/postgresql/archive/${currentCoverage.accountPg.walFile}`], 10_000); return true; }
      catch { return false; }
    };
    for (let attempt = 0; attempt < 120 && !accountWalArchived(); attempt++) {
      await Bun.sleep(100);
    }
    docker(['cp', `${sourcePostgres}:/var/lib/postgresql/archive`, accountArchive]);
    expect(existsSync(join(accountArchive, currentCoverage.accountPg.walFile))).toBe(true);
    await accountApp.stop();
    accountApp = undefined;
    await accountPool.end();
    accountDatabase = undefined;
    cpSync(accountBackup, accountRestoredPg, { recursive: true });
    rmSync(join(accountRestoredPg, 'pg_wal'), { recursive: true });
    mkdirSync(join(accountRestoredPg, 'pg_wal'));
    // Replay the archived source timeline through its signed capture frontier,
    // then promote without waiting for archive exhaustion or a paused target.
    appendFileSync(join(accountRestoredPg, 'postgresql.auto.conf'),
      `\narchive_mode = off
restore_command = 'cp /recovery/archive/%f %p'
recovery_target_lsn = '${currentCoverage.accountPg.flushedLsn}'
recovery_target_timeline = '0x${currentCoverage.accountPg.walFile.slice(0, 8)}'
recovery_target_inclusive = on
recovery_target_action = 'promote'
`);
    writeFileSync(join(accountRestoredPg, 'recovery.signal'), '');
    accountRestoredDatabase = await startPg(accountRestoredPg, 'account-restored');
    releaseAccountPool = accountRestoredDatabase.pool;
    for (let attempt = 0; attempt < 120; attempt++) {
      const recovering = (await releaseAccountPool.query<{ recovering: boolean }>(
        'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering;
      if (recovering === false) break;
      if (attempt === 119) throw new Error(
        `Account WAL restore did not complete: ${dockerLogs(`${project}-account-restored`)}`);
      await Bun.sleep(250);
    }
    accountApp = createAccountApp(createAccountAuth(accountConfig(releaseAccountPool)),
      releaseAccountPool).listen({ hostname: '127.0.0.1', port: accountPort });
    await contentPool.end();
    contentDatabase = undefined;
    await stopFuseki();
    graph = undefined;
    await pool.end();
    database = undefined;
    saveGraph(liveBase);
    cpSync(liveBase, savedBase, { recursive: true });
    cpSync(liveObjects, savedObjects, { recursive: true });
    // One physical cut captures Access and Content while the independently
    // retained relay database stays in the source stack for later effects.
    backupPg(savedPg);
    // Keep the signed Access cut held through its physical backup; releasing
    // the source fence records new discovery authority history afterward.
    expect(JSON.parse(execFileSync(process.execPath,
      [fenceCli, 'release', captureFence.generation], {
        cwd: root, env: { ...process.env, ACCESS_RECOVERY_DATABASE_URL: accessUrl },
        encoding: 'utf8',
      })).released).toBe(true);
    cpSync(savedBase, restoreBase, { recursive: true });
    cpSync(savedObjects, restoreObjects, { recursive: true });
    cpSync(savedPg, restorePg, { recursive: true });
    appendFileSync(join(restorePg, 'postgresql.auto.conf'), "\narchive_mode = off\nrestore_command = 'false'\n");
    writeFileSync(join(restorePg, 'recovery.signal'), '');
    graph = await startFuseki(restoreBase, 'restore');
    database = await startPg(restorePg, 'restore');
    contentDatabase = await startPg(contentRestoredPg, 'content-restored');
    fuseki = graph.fuseki;
    pool = database.pool;
    access = new AccessAdmissionRegistry(pool);
    const restoredContent = new ContentCore(contentDatabase.pool);
    const restoredComments = new ContentComments(contentDatabase.pool);
    expect(await restoredContent.ownerPosition()).toEqual(contentCut);
    const nextLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '2' };
    let accessFenceGeneration = await engageAccessRecoveryFence(pool);
    const restoredEnv: WorkActivationEnvironment = { ...liveEnv, fuseki,
      lineage: nextLineage, objectDirectory: restoreObjects,
      candidateDirectory: join(state, 'restore', 'candidates') };
    expect((await readExactWorkRevision(restoredEnv, created.workRevision, async () => true)).title).toBe('Backup Work');
    expect((await readExactWorkRevision(restoredEnv, edited.revision, async () => true)).title).toBe('Backup edited Work');
    expect((await pool.query<{ count: string }>('SELECT count(*) FROM access.admission WHERE state = \'sealed\''))
      .rows[0]!.count).toBe('7');
    const cutover = { prior: { ...oldLineage, sequence: '2' }, next: nextLineage };
    class LostCutoverResponseClient extends FusekiClient {
      override async command(envelope: CommandEnvelope): Promise<CommandResult> {
        await super.command(envelope);
        throw new Error('simulated lost cutover response');
      }
    }
    expect(await cutoverRestoredGraphLineage(
      new LostCutoverResponseClient(graph.url), cutover)).toEqual({
      lineage: nextLineage, sequence: '0', replayed: false,
    });
    expect((await cutoverRestoredGraphLineage(fuseki, cutover)).replayed).toBe(true);
    const oldReadiness = await createMainApp(fuseki, { environment: { ...restoredEnv, lineage: oldLineage },
      account, access }).handle(new Request('http://localhost/health/ready'));
    expect(oldReadiness.status).toBe(503);
    const newReadiness = await createMainApp(fuseki, { environment: restoredEnv,
      account, access }).handle(new Request('http://localhost/health/ready'));
    expect(newReadiness.status).toBe(503);
    expect((await createMainApp(fuseki, { environment: restoredEnv,
      account, access }).handle(new Request('http://localhost/health/search-ready'))).status)
      .toBe(503);
    // Probe the independent source owner: real fence transitions append
    // authority history, while the restored owner's signed cut stays held.
    const unheldAccessProbe = new Pool({ connectionString: accessUrl });
    try {
      const probeFenceGeneration = await engageAccessRecoveryFence(unheldAccessProbe);
      await releaseAccessRecoveryFence(unheldAccessProbe, probeFenceGeneration);
      await expect(releaseGraphHold(fuseki, unheldAccessProbe, journal.pool, nextLineage, {
        priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
        accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
        accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
        relay: externalRelay,
      })).rejects.toThrow('Access recovery fence is not held');
    } finally { await unheldAccessProbe.end(); }
    accessFenceGeneration = await engageAccessRecoveryFence(pool);
    await expect(createAdmittedMetadataWork(restoredEnv, account, access, request, createInput))
      .rejects.toBeInstanceOf(RecoveryHold);
    const heldApp = createMainApp(fuseki, { environment: restoredEnv, account, access,
      content: restoredContent, comments: restoredComments });
    const heldResponse = await heldApp.handle(new Request('http://localhost/v1/works', {
      method: 'POST', headers: { authorization: bearer,
        'content-type': 'application/json', 'idempotency-key': createInput.idempotencyKey },
      body: JSON.stringify({ profile: 'metadata-only-v1', authoring: 'own-work', title: createInput.title,
        language: createInput.language, actingSubject: actor }),
    }));
    expect(heldResponse.status).toBe(503);
    expect((await heldResponse.json() as { code: string }).code).toBe('recovery_hold');
    const exactReadRequest = () => new Request(
      `http://localhost/v1/revisions/${created.workRevision.split('/').at(-1)}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: bearer } });
    const heldRead = await heldApp.handle(exactReadRequest());
    expect(heldRead.status).toBe(503);
    expect((await heldRead.json() as { code: string }).code).toBe('recovery_hold');
    for (const heldRequest of [commentReadRequest(), commentListRequest(),
      commentPageRequest(firstPage.next!),
      contentReadRequest(), commentRequest()]) {
      const held = await heldApp.handle(heldRequest);
      expect(held.status).toBe(503);
      expect((await held.json() as { code: string }).code).toBe('recovery_hold');
    }
    const oldWorkerIntent = { admission: { id: Bun.randomUUIDv7(), scope: editScope,
      action: 'work.edit', requestDigest: metadataWorkEditDigest(created.work, edited.revision, 'Old worker title'),
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      work: created.work, expectedHead: edited.revision, title: 'Old worker title' };
    await expect(editMetadataWork({ ...restoredEnv, lineage: oldLineage }, oldWorkerIntent))
      .rejects.toBeInstanceOf(PendingActivation);
    await expect(releaseGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '3',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(releaseGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: '0'.repeat(64),
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(releaseGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: '0'.repeat(64),
      relay: externalRelay,
    })).rejects.toThrow('Access state differs from recovery coverage');
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, nextLineage, {
      ...releaseEvidence(fuseki, pool, journal.pool, nextLineage, capturedCoverage, restoreObjects),
      hmacKey: 'cd'.repeat(32),
    })).rejects.toThrow('recovery coverage envelope is invalid');
    await expect(releaseRestoredGraphHold(fuseki, pool, journal.pool, nextLineage, {
      ...releaseEvidence(fuseki, pool, journal.pool, nextLineage, capturedCoverage, restoreObjects),
      contentPool: undefined,
    })).rejects.toThrow('restored Content owner is unavailable');
    expect(await accountRecoveryCoverage(releaseAccountPool)).toEqual(externalAccount);
    await releaseRestoredGraphHold(fuseki, pool, journal.pool, nextLineage, {
      ...releaseEvidence(fuseki, pool, journal.pool, nextLineage, capturedCoverage, restoreObjects),
    });
    // Native introspection records grant.last_used_at. Verify after releasing
    // the signed cut; renew on the independent source when QA admission outlives
    // the original 300-second credential, retaining the restored session/key proof.
    const renewalOwner = poolAt('account');
    try {
      const renewalApp = createAccountApp(createAccountAuth(accountConfig(renewalOwner.pool)),
        renewalOwner.pool);
      const renewedToken = (await signIn({
        account: accountBase, clientId: browserClient.client_id, redirectUri,
        scope: oauthScope, resource: accountConfig(renewalOwner.pool).resource,
        fetch: async (input, init) => renewalApp.handle(new Request(input, init)),
      }, signedIn.headers.get('set-cookie')!)).accessToken;
      bearer = `Bearer ${renewedToken}`;
      request.headers.set('authorization', bearer);
      expectedAccountAssertion.accountExpiresAt = decodeJwt(renewedToken).exp;
    } finally { await renewalOwner.pool.end(); }
    expect(await account.verify(request, ['work:create'])).toEqual(expectedAccountAssertion);
    await expect(releaseGraphHold(fuseki, pool, journal.pool, nextLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    })).resolves.toBeUndefined();
    await expect(access.register({ principal, actingSubject: actor, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: 'held-access',
      requestDigest: '0'.repeat(64) })).rejects.toThrow('Access is held for recovery');
    await releaseAccessRecoveryFence(pool, accessFenceGeneration);
    const releasedReadiness = await createMainApp(fuseki, { environment: restoredEnv,
      account, access }).handle(new Request('http://localhost/health/ready'));
    expect(releasedReadiness.status).toBe(200);
    const restoredRead = await createMainApp(fuseki, { environment: restoredEnv,
      account, access }).handle(exactReadRequest());
    expect(restoredRead.status).toBe(200);
    expect(await restoredRead.json()).toMatchObject({ revision: created.workRevision,
      work: created.work, title: 'Backup Work' });
    const restoredApp = createMainApp(fuseki, { environment: restoredEnv, account, access,
      content: restoredContent, comments: restoredComments });
    const restoredWorkReplay = await restoredApp.handle(workApiRequest());
    expect(restoredWorkReplay.status).toBe(200);
    expect(await restoredWorkReplay.json()).toMatchObject({ work: created.work,
      workRevision: created.workRevision, replayed: true });
    const restoredComment = await restoredApp.handle(commentReadRequest());
    expect(restoredComment.status).toBe(200);
    expect(await restoredComment.json()).toMatchObject({ comment: createdComment.comment,
      revisionId: firstDraft.revisionId, resolvedText: exactParagraph,
      target: { selector: { exact: exactParagraph } } });
    const restoredCommentList = await restoredApp.handle(commentListRequest());
    expect(restoredCommentList.status).toBe(200);
    expect(await restoredCommentList.json()).toMatchObject({
      comments: [createdComment, secondComment, afterCutComment].map(item => ({
        comment: item.comment, resolvedText: exactParagraph })), next: null });
    const retainedSecondPage = await restoredApp.handle(commentPageRequest(firstPage.next!));
    expect(retainedSecondPage.status).toBe(200);
    expect(await retainedSecondPage.json()).toMatchObject({
      comments: [{ comment: secondComment.comment, resolvedText: exactParagraph }], next: null });
    const freshFirstPage = await restoredApp.handle(commentPageRequest());
    expect(freshFirstPage.status).toBe(200);
    const freshFirst = await freshFirstPage.json() as { next: string | null };
    const freshSecondPage = await restoredApp.handle(commentPageRequest(freshFirst.next!));
    expect(freshSecondPage.status).toBe(200);
    const freshSecond = await freshSecondPage.json() as { next: string | null };
    const freshThirdPage = await restoredApp.handle(commentPageRequest(freshSecond.next!));
    expect(freshThirdPage.status).toBe(200);
    expect(await freshThirdPage.json()).toMatchObject({
      comments: [{ comment: afterCutComment.comment, resolvedText: exactParagraph }], next: null });
    const restoredContentRead = await restoredApp.handle(contentReadRequest());
    expect(restoredContentRead.status).toBe(200);
    expect(await restoredContentRead.json()).toMatchObject({
      reference: { revisionId: firstDraft.revisionId }, body: { body: draftBody },
    });
    const replayedComment = await restoredApp.handle(commentRequest());
    expect(replayedComment.status).toBe(200);
    expect(await replayedComment.json()).toMatchObject({ comment: createdComment.comment,
      replayed: true });
    const readClosure = await access.strongCloseScope(readScope, '0');
    expect(readClosure.pending).toBe(0);
    expect((await restoredApp.handle(exactReadRequest())).status).toBe(404);
    expect((await restoredApp.handle(commentReadRequest())).status).toBe(404);
    expect((await restoredApp.handle(commentListRequest())).status).toBe(404);
    expect((await restoredApp.handle(commentPageRequest(firstPage.next!))).status).toBe(404);
    expect((await restoredApp.handle(contentReadRequest())).status).toBe(404);
    expect((await restoredComments.read(createdComment.comment.split('/').at(-1)!))?.comment)
      .toBe(createdComment.comment);
    expect((await restoredContent.readExactBatch([firstDraft.revisionId],
      async ids => new Set(ids)))[0]?.status).toBe('available');
    expect((await createMainApp(fuseki, { environment: restoredEnv,
      account, access }).handle(new Request('http://localhost/health/search-ready'))).status)
      .toBe(200);
    const replayed = await createAdmittedMetadataWork(restoredEnv, account, access, request, createInput);
    expect(replayed).toEqual({ ...created, replayed: true });
    const newEditInput = { work: created.work, expectedHead: edited.revision,
      title: 'After restore Work', actingSubject: actor, idempotencyKey: 'after-restore-edit' };
    const afterRestore = await editAdmittedMetadataWork(restoredEnv, account, access, request, newEditInput);
    expect(afterRestore.dataEpoch).toBe(nextLineage.dataEpoch);
    expect(afterRestore.sequence).toBe('1');
    expect((await readExactWorkRevision(restoredEnv, created.workRevision, async () => true)).title).toBe('Backup Work');
    expect((await readExactWorkRevision(restoredEnv, edited.revision, async () => true)).title).toBe('Backup edited Work');
    const latest = await readExactWorkRevision(restoredEnv, afterRestore.revision, async () => true);
    expect(latest.title).toBe('After restore Work');
    expect(latest.sourcePosition).toEqual({ datasetId: 'product', dataEpoch: nextLineage.dataEpoch, sequence: '1' });
    expect((await pool.query<{ count: string }>('SELECT count(*) FROM access.admission WHERE state = \'sealed\''))
      .rows[0]!.count).toBe('8');
    const textMatch = await fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?work WHERE { GRAPH <urn:rezics:graph:current> {
        (?work ?score ?literal) text:query (rdfs:label "After restore" 10) .
        ?work rdfs:label ?literal .
      } }`);
    expect(textMatch.results?.bindings.map(row => row.work?.value)).toContain(created.work);

    // A separate timeline commits after the saved cut. Restoring that older cut
    // cannot safely replay the later key without the authoritative journal.
    await stopFuseki();
    graph = undefined;
    await pool.end();
    database = undefined;
    graph = await startFuseki(liveBase, 'later-live');
    database = await startPg(livePg, 'later-live');
    fuseki = graph.fuseki;
    pool = database.pool;
    access = new AccessAdmissionRegistry(pool);
    const laterInput = { work: created.work, expectedHead: edited.revision,
      title: 'Effect after saved cut', actingSubject: actor, idempotencyKey: 'later-effect' };
    const laterEffect = await editAdmittedMetadataWork({ ...liveEnv, fuseki }, account, access, request, laterInput);
    expect(laterEffect.sequence).toBe('3');
    const laterCreateInput = { actingSubject: actor, idempotencyKey: 'later-create',
      title: 'Created after saved cut', language: 'en' };
    const laterCreate = await createAdmittedMetadataWork({ ...liveEnv, fuseki },
      account, access, request, laterCreateInput);
    expect(laterCreate.sequence).toBe('4');
    const cancelledInput = { actingSubject: actor, idempotencyKey: 'later-cancelled-create',
      title: 'Cancelled after saved cut', language: 'en' };
    const cancelledAdmission = await access.register({ principal,
      actingSubject: actor, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: cancelledInput.idempotencyKey,
      requestDigest: metadataWorkRequestDigest(cancelledInput.title, undefined, cancelledInput.language) });
    const cancelledReceipt = await sealMetadataWorkAdmission({ ...liveEnv, fuseki }, cancelledAdmission);
    await access.recordGraphOutcome(cancelledAdmission.id, cancelledReceipt);
    expect(cancelledReceipt.sequence).toBe('5');
    const staleInput = { work: created.work, expectedHead: created.workRevision,
      title: 'Rejected after saved cut', actingSubject: actor, idempotencyKey: 'later-stale-edit' };
    await expect(editAdmittedMetadataWork({ ...liveEnv, fuseki }, account, access, request, staleInput))
      .rejects.toBeInstanceOf(StaleWorkHead);
    const emptyBatch = `urn:rezics:outbox:${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 .
        <${MAIN_RELAY_STREAM_SCOPE}> rv:streamSequence 6 } }
      INSERT { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 7 .
        <${MAIN_RELAY_STREAM_SCOPE}> rv:streamSequence 7 }
        GRAPH <urn:rezics:graph:outbox> { <${emptyBatch}> a rv:OutboxBatch ;
          rv:dataEpoch "${oldLineage.dataEpoch}" ; rv:sequence 7 ; rv:eventCount 0 ;
          rv:streamScope "${MAIN_RELAY_STREAM_SCOPE}" ; rv:streamSequence 7 . } }
      WHERE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 .
        <${MAIN_RELAY_STREAM_SCOPE}> rv:streamSequence 6 } }`);
    const contributionScope = `contribution:create:${created.work}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [contributionScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, contributionScope]);
    const laterDraftInput = { work: created.work, language: 'en',
      body: 'Retained private draft', actingSubject: actor, idempotencyKey: 'later-draft' };
    const laterDraft = await createAdmittedTextContribution({ ...liveEnv, fuseki },
      account, access, request, laterDraftInput);
    expect(laterDraft.sequence).toBe('8');
    const cancelledDraftInput = { ...laterDraftInput, body: 'Cancelled private draft',
      idempotencyKey: 'later-cancelled-draft' };
    const cancelledDraftAdmission = await access.register({ principal,
      actingSubject: actor, scope: contributionScope, action: 'contribution.create',
      idempotencyKey: cancelledDraftInput.idempotencyKey,
      requestDigest: textContributionDigest(cancelledDraftInput) });
    const cancelledDraftReceipt = await sealTextContributionAdmission(
      { ...liveEnv, fuseki }, cancelledDraftAdmission);
    await access.recordGraphOutcome(cancelledDraftAdmission.id, cancelledDraftReceipt);
    expect(cancelledDraftReceipt.sequence).toBe('9');
    const contributionEditScope = `contribution:edit:${laterDraft.contribution}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [contributionEditScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.edit', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.edit', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, contributionEditScope]);
    const laterDraftEditInput = { contribution: laterDraft.contribution!,
      expectedHead: laterDraft.draftRevision!, body: 'Retained edited private draft',
      actingSubject: actor, idempotencyKey: 'later-draft-edit' };
    const laterDraftEdit = await editAdmittedTextContribution({ ...liveEnv, fuseki },
      account, access, request, laterDraftEditInput);
    expect(laterDraftEdit.sequence).toBe('10');
    const staleDraftEditInput = { ...laterDraftEditInput, body: 'Stale retained draft',
      idempotencyKey: 'later-stale-draft-edit' };
    await expect(editAdmittedTextContribution({ ...liveEnv, fuseki }, account, access,
      request, staleDraftEditInput)).rejects.toBeInstanceOf(StaleContributionDraftHead);
    const cancelledDraftEditInput = { ...laterDraftEditInput,
      expectedHead: laterDraftEdit.draftRevision!, body: 'Cancelled retained draft edit',
      idempotencyKey: 'later-cancelled-draft-edit' };
    const cancelledDraftEditAdmission = await access.register({ principal,
      actingSubject: actor, scope: contributionEditScope, action: 'contribution.edit',
      idempotencyKey: cancelledDraftEditInput.idempotencyKey,
      requestDigest: textContributionEditDigest(cancelledDraftEditInput) });
    const cancelledDraftEditReceipt = await sealTextContributionEditAdmission(
      { ...liveEnv, fuseki }, cancelledDraftEditAdmission);
    await access.recordGraphOutcome(cancelledDraftEditAdmission.id, cancelledDraftEditReceipt);
    expect(cancelledDraftEditReceipt.sequence).toBe('12');
    const publicationScope = `contribution:publish:${laterDraft.contribution}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [publicationScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.publish', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.publish', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, publicationScope]);
    const laterPublicationInput = { contribution: laterDraft.contribution!,
      expectedDraftHead: laterDraftEdit.draftRevision!, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
      idempotencyKey: 'later-publication' } as const;
    const laterPublication = await publishAdmittedTextContribution({ ...liveEnv, fuseki },
      account, access, request, laterPublicationInput);
    expect(laterPublication.sequence).toBe('13');
    const stalePublicationInput = { ...laterPublicationInput,
      idempotencyKey: 'later-stale-publication' };
    await expect(publishAdmittedTextContribution({ ...liveEnv, fuseki }, account, access,
      request, stalePublicationInput)).rejects.toBeInstanceOf(StalePublicationHead);
    const cancelledPublicationInput = { ...laterPublicationInput,
      expectedPublicationHead: laterPublication.publicationDecision!,
      idempotencyKey: 'later-cancelled-publication' };
    const cancelledPublicationAdmission = await access.register({ principal,
      actingSubject: actor, scope: publicationScope, action: 'contribution.publish',
      idempotencyKey: cancelledPublicationInput.idempotencyKey,
      requestDigest: textPublicationDigest(cancelledPublicationInput) });
    const cancelledPublicationReceipt = await sealTextPublicationAdmission(
      { ...liveEnv, fuseki }, cancelledPublicationAdmission);
    await access.recordGraphOutcome(cancelledPublicationAdmission.id, cancelledPublicationReceipt);
    expect(cancelledPublicationReceipt.sequence).toBe('15');
    const selectionScope = `publication:select:${created.mainVersion}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [selectionScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'publication.select', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'publication.select', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, selectionScope]);
    const laterSelectionInput = { context: { kind: 'main-version-default', id: created.mainVersion },
      work: created.work, contribution: laterDraft.contribution!,
      publicationDecision: laterPublication.publicationDecision!, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer', actingSubject: actor,
      idempotencyKey: 'later-main-selection' } as const;
    const laterSelection = await selectAdmittedMainDefault({ ...liveEnv, fuseki },
      account, access, request, laterSelectionInput);
    expect(laterSelection.sequence).toBe('16');
    const staleSelectionInput = { ...laterSelectionInput,
      idempotencyKey: 'later-stale-main-selection' };
    await expect(selectAdmittedMainDefault({ ...liveEnv, fuseki }, account, access,
      request, staleSelectionInput)).rejects.toBeInstanceOf(StaleMainSelection);
    const cancelledSelectionInput = { ...laterSelectionInput,
      expectedSelectionHead: laterSelection.selection!,
      idempotencyKey: 'later-cancelled-main-selection' };
    const cancelledSelectionAdmission = await access.register({ principal,
      actingSubject: actor, scope: selectionScope, action: 'publication.select',
      idempotencyKey: cancelledSelectionInput.idempotencyKey,
      requestDigest: mainSelectionDigest(cancelledSelectionInput) });
    const cancelledSelectionReceipt = await sealMainSelectionAdmission(
      { ...liveEnv, fuseki }, cancelledSelectionAdmission);
    await access.recordGraphOutcome(cancelledSelectionAdmission.id, cancelledSelectionReceipt);
    expect(cancelledSelectionReceipt.sequence).toBe('18');
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('space:create:root') ON CONFLICT (id) DO NOTHING");
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'space.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'space:create:root', 'space.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor]);
    const laterSpaceInput = { name: 'Retained Realm Space', actingSubject: actor,
      idempotencyKey: 'later-space-create' };
    const laterSpace = await createAdmittedRealmSpace({ ...liveEnv, fuseki },
      account, access, request, laterSpaceInput);
    expect(laterSpace.sequence).toBe('19');
    const cancelledSpaceInput = { name: 'Cancelled Realm Space', actingSubject: actor,
      idempotencyKey: 'later-space-cancelled' };
    const cancelledSpaceAdmission = await access.register({ principal,
      actingSubject: actor, scope: 'space:create:root', action: 'space.create',
      idempotencyKey: cancelledSpaceInput.idempotencyKey,
      requestDigest: spaceCreationDigest(cancelledSpaceInput) });
    const cancelledSpaceReceipt = await sealRealmSpaceAdmission(
      { ...liveEnv, fuseki }, cancelledSpaceAdmission);
    await access.recordGraphOutcome(cancelledSpaceAdmission.id, cancelledSpaceReceipt);
    expect(cancelledSpaceReceipt.sequence).toBe('20');
    const realmAdoptionScope = `publication:adopt:${laterSpace.realm}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [realmAdoptionScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'publication.adopt', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'publication.adopt', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, realmAdoptionScope]);
    const laterRealmInput = { context: { kind: 'realm-local', id: laterSpace.realm! },
      work: created.work, mainVersion: created.mainVersion,
      contribution: laterDraft.contribution!,
      publicationDecision: laterPublication.publicationDecision!,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
      actingSubject: actor, idempotencyKey: 'later-realm-adoption' } as const;
    const laterRealm = await selectAdmittedRealmLocal({ ...liveEnv, fuseki },
      account, access, request, laterRealmInput);
    expect(laterRealm.sequence).toBe('21');
    const staleRealmInput = { ...laterRealmInput,
      idempotencyKey: 'later-stale-realm-adoption' };
    await expect(selectAdmittedRealmLocal({ ...liveEnv, fuseki }, account, access,
      request, staleRealmInput)).rejects.toBeInstanceOf(StaleRealmSelection);
    const cancelledRealmInput = { ...laterRealmInput,
      expectedSelectionHead: laterRealm.selection!,
      idempotencyKey: 'later-cancelled-realm-adoption' };
    const cancelledRealmAdmission = await access.register({ principal,
      actingSubject: actor, scope: realmAdoptionScope, action: 'publication.adopt',
      idempotencyKey: cancelledRealmInput.idempotencyKey,
      requestDigest: realmSelectionDigest(cancelledRealmInput) });
    const cancelledRealmReceipt = await sealRealmSelectionAdmission(
      { ...liveEnv, fuseki }, cancelledRealmAdmission);
    await access.recordGraphOutcome(cancelledRealmAdmission.id, cancelledRealmReceipt);
    expect(cancelledRealmReceipt.sequence).toBe('23');
    const realmRejectionScope = `publication:reject:${laterSpace.realm}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [realmRejectionScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'publication.reject', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'publication.reject', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, realmRejectionScope]);
    const laterRejectionInput = { context: { kind: 'realm-local', id: laterSpace.realm! },
      work: created.work, mainVersion: created.mainVersion,
      expectedSelectionHead: laterRealm.selection!,
      decisionBasis: 'realm-manager-review', reasonCode: 'not-approved',
      actingSubject: actor, idempotencyKey: 'later-realm-rejection' } as const;
    const laterRejection = await rejectAdmittedRealmLocal({ ...liveEnv, fuseki },
      account, access, request, laterRejectionInput);
    expect(laterRejection.sequence).toBe('24');
    const staleRejectionInput = { ...laterRejectionInput,
      idempotencyKey: 'later-stale-realm-rejection' };
    await expect(rejectAdmittedRealmLocal({ ...liveEnv, fuseki }, account, access,
      request, staleRejectionInput)).rejects.toBeInstanceOf(StaleRealmRejection);
    const cancelledRejectionInput = { ...laterRejectionInput,
      expectedSelectionHead: laterRejection.rejection!,
      idempotencyKey: 'later-cancelled-realm-rejection' };
    const cancelledRejectionAdmission = await access.register({ principal,
      actingSubject: actor, scope: realmRejectionScope, action: 'publication.reject',
      idempotencyKey: cancelledRejectionInput.idempotencyKey,
      requestDigest: realmRejectionDigest(cancelledRejectionInput) });
    const cancelledRejectionReceipt = await sealRealmRejectionAdmission(
      { ...liveEnv, fuseki }, cancelledRejectionAdmission);
    await access.recordGraphOutcome(cancelledRejectionAdmission.id, cancelledRejectionReceipt);
    expect(cancelledRejectionReceipt.sequence).toBe('26');
    const contextScope = `classification:context:${laterSpace.realm}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [contextScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'classification.context.configure', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'classification.context.configure', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, contextScope]);
    const laterContextInput = { realm: laterSpace.realm!, actingSubject: actor,
      idempotencyKey: 'later-classification-context' };
    const laterContext = await createAdmittedClassificationContext({ ...liveEnv, fuseki },
      account, access, request, laterContextInput);
    expect(laterContext.sequence).toBe('27');
    const cancelledContextInput = { ...laterContextInput,
      idempotencyKey: 'later-classification-context-cancelled' };
    const cancelledContextAdmission = await access.register({ principal,
      actingSubject: actor, scope: contextScope, action: 'classification.context.configure',
      idempotencyKey: cancelledContextInput.idempotencyKey,
      requestDigest: classificationContextDigest(cancelledContextInput) });
    const cancelledContextReceipt = await sealClassificationContextAdmission(
      { ...liveEnv, fuseki }, cancelledContextAdmission);
    await access.recordGraphOutcome(cancelledContextAdmission.id, cancelledContextReceipt);
    expect(cancelledContextReceipt.sequence).toBe('28');
    const propositionScope = 'classification:define:global';
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [propositionScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'classification.proposition.define', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'classification.proposition.define', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, propositionScope]);
    const laterPropositionInput = { label: 'Science fiction', actingSubject: actor,
      idempotencyKey: 'later-classification-proposition' };
    const laterProposition = await createAdmittedClassificationProposition(
      { ...liveEnv, fuseki }, account, access, request, laterPropositionInput);
    expect(laterProposition.sequence).toBe('29');
    const cancelledPropositionInput = { ...laterPropositionInput,
      idempotencyKey: 'later-classification-proposition-cancelled' };
    const cancelledPropositionAdmission = await access.register({ principal,
      actingSubject: actor, scope: propositionScope,
      action: 'classification.proposition.define',
      idempotencyKey: cancelledPropositionInput.idempotencyKey,
      requestDigest: classificationPropositionDigest(cancelledPropositionInput) });
    const cancelledPropositionReceipt = await sealClassificationPropositionAdmission(
      { ...liveEnv, fuseki }, cancelledPropositionAdmission);
    await access.recordGraphOutcome(cancelledPropositionAdmission.id, cancelledPropositionReceipt);
    expect(cancelledPropositionReceipt.sequence).toBe('30');
    const decisionScopes = ['classification:decide:global',
      `classification:decide:${laterSpace.realm}`];
    for (const scope of decisionScopes) {
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'classification.decision.set', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    for (const scope of decisionScopes) {
      await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'classification.decision.set', now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), actor, scope]);
    }
    const globalDecisionInput = { context: { kind: 'global' as const },
      work: created.work, mainVersion: created.mainVersion,
      sense: laterProposition.definitions!.sense, expectedDecisionHead: null,
      outcome: 'accepted' as const, actingSubject: actor,
      idempotencyKey: 'later-global-classification-decision' };
    const globalDecision = await setAdmittedClassificationDecision(
      { ...liveEnv, fuseki }, account, access, request, globalDecisionInput);
    expect(globalDecision.sequence).toBe('31');
    const realmDecisionInput = { ...globalDecisionInput,
      context: { kind: 'realm-classification' as const, id: laterSpace.realm! },
      outcome: 'rejected' as const, idempotencyKey: 'later-realm-classification-decision' };
    const realmDecision = await setAdmittedClassificationDecision(
      { ...liveEnv, fuseki }, account, access, request, realmDecisionInput);
    expect(realmDecision.sequence).toBe('32');
    const revisedDecisionInput = { ...realmDecisionInput,
      expectedDecisionHead: realmDecision.decision!, outcome: 'accepted' as const,
      idempotencyKey: 'later-revised-classification-decision' };
    const revisedDecision = await setAdmittedClassificationDecision(
      { ...liveEnv, fuseki }, account, access, request, revisedDecisionInput);
    expect(revisedDecision.sequence).toBe('33');
    const cancelledDecisionInput = { ...globalDecisionInput,
      idempotencyKey: 'later-cancelled-classification-decision' };
    const cancelledDecisionAdmission = await access.register({ principal,
      actingSubject: actor, scope: decisionScopes[0]!, action: 'classification.decision.set',
      idempotencyKey: cancelledDecisionInput.idempotencyKey,
      requestDigest: classificationDecisionDigest(cancelledDecisionInput) });
    const cancelledDecisionReceipt = await sealClassificationDecisionAdmission(
      { ...liveEnv, fuseki }, cancelledDecisionAdmission);
    await access.recordGraphOutcome(cancelledDecisionAdmission.id, cancelledDecisionReceipt);
    expect(cancelledDecisionReceipt.sequence).toBe('34');
    const ratingScope = `rating:context:${laterSpace.realm}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [ratingScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'rating.context.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'rating.context.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, ratingScope]);
    const laterRatingInput = { realm: laterSpace.realm!, question: 'How good is this work?',
      actingSubject: actor, idempotencyKey: 'later-realm-standing-rating-context' };
    const laterRating = await createAdmittedRatingContext(
      { ...liveEnv, fuseki }, account, access, request, laterRatingInput);
    expect(laterRating.sequence).toBe('35');
    const cancelledRatingInput = { ...laterRatingInput,
      idempotencyKey: 'later-cancelled-rating-context' };
    const cancelledRatingAdmission = await access.register({ principal,
      actingSubject: actor, scope: ratingScope, action: 'rating.context.create',
      idempotencyKey: cancelledRatingInput.idempotencyKey,
      requestDigest: ratingContextDigest(cancelledRatingInput) });
    const cancelledRatingReceipt = await sealRatingContextAdmission(
      { ...liveEnv, fuseki }, cancelledRatingAdmission);
    await access.recordGraphOutcome(cancelledRatingAdmission.id, cancelledRatingReceipt);
    expect(cancelledRatingReceipt.sequence).toBe('36');
    const observationScope = `rating:observe:${laterRating.context}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [observationScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'rating.observation.set', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'rating.observation.set', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, observationScope]);
    const laterObservationInput = { context: laterRating.context!, work: created.work,
      mainVersion: created.mainVersion, expectedRevisionHead: null, value: 7,
      actingSubject: actor, idempotencyKey: 'later-standing-rating-first' };
    const laterObservation = await setAdmittedStandingRating(
      { ...liveEnv, fuseki }, account, access, request, laterObservationInput);
    expect(laterObservation.sequence).toBe('37');
    const laterCorrectionInput = { ...laterObservationInput,
      expectedRevisionHead: laterObservation.revision!, value: 9,
      idempotencyKey: 'later-standing-rating-correction' };
    const laterCorrection = await setAdmittedStandingRating(
      { ...liveEnv, fuseki }, account, access, request, laterCorrectionInput);
    expect(laterCorrection.sequence).toBe('38');
    expect(laterCorrection.observation).toBe(laterObservation.observation);
    const laterWithdrawalInput = { ...laterObservationInput,
      expectedRevisionHead: laterCorrection.revision!, value: null,
      idempotencyKey: 'later-standing-rating-withdrawal' };
    const laterWithdrawal = await setAdmittedStandingRating(
      { ...liveEnv, fuseki }, account, access, request, laterWithdrawalInput);
    expect(laterWithdrawal.sequence).toBe('39');
    const cancelledObservationInput = { ...laterObservationInput,
      expectedRevisionHead: laterWithdrawal.revision!, value: 6,
      idempotencyKey: 'later-standing-rating-cancelled' };
    const cancelledObservationAdmission = await access.register({ principal,
      actingSubject: actor, scope: observationScope, action: 'rating.observation.set',
      idempotencyKey: cancelledObservationInput.idempotencyKey,
      requestDigest: standingRatingDigest(cancelledObservationInput) });
    const cancelledObservationReceipt = await sealStandingRatingAdmission(
      { ...liveEnv, fuseki }, cancelledObservationAdmission);
    await access.recordGraphOutcome(cancelledObservationAdmission.id,
      cancelledObservationReceipt);
    expect(cancelledObservationReceipt.sequence).toBe('40');
    const laterClosure = await access.strongCloseScope('work:create:root', '0');
    expect(laterClosure.authorityEpoch).toBe('1');
    expect(laterClosure.pending).toBe(0);
    const laterAccessOutbox = await accessOutboxCoverage(pool);
    const laterAccessState = await accessStateCoverage(pool);
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('3');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('4');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('5');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('6');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('7');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('8');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('9');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('10');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('11');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('12');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('13');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('14');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('15');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('16');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('17');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('18');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('19');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('20');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('21');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('22');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('23');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('24');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('25');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('26');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('27');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('28');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('29');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('30');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('31');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('32');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('33');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('34');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('35');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('36');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('37');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('38');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('39');
    expect((await relayMainOutboxOnce(fuseki, journal.pool, 'recovery-handoff'))?.sequence).toBe('40');
    const laterRelay = await relayCoverage(journal.pool, 'recovery-handoff');
    expect(laterRelay.batchCount).toBe('40');
    expect(laterRelay.eventCount).toBe('39');
    laterObjects = await captureObjectRecoveryCoverage(fuseki, { directory: liveObjects });
    await retainRecoveryCoverageHead(journal.pool, JSON.stringify(sealRecoveryPayload({
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '40',
      accountPg: currentCoverage.accountPg, account: externalAccount,
      commerce: currentCoverage.commerce, objects: laterObjects,
      accessOutboxCount: laterAccessOutbox.count,
      accessOutboxDigest: laterAccessOutbox.digest,
      accessStateCount: laterAccessState.count,
      accessStateDigest: laterAccessState.digest, relay: laterRelay,
      ...(currentCoverage.content ? { content: currentCoverage.content } : {}),
    }, recoveryKey, 'graph-recovery-coverage')), recoveryKey);
    expect((await journal.pool.query<{ generation: string }>(
      'SELECT generation FROM relay.recovery_coverage_head WHERE consumer = $1',
      ['recovery-handoff'])).rows[0]?.generation).toBe('2');
    await stopFuseki();
    graph = undefined;
    await pool.end();
    database = undefined;
    const olderBase = join(state, 'older-restore', 'run');
    const olderPg = join(state, 'older-restore', 'pgdata');
    mkdirSync(join(state, 'older-restore'), { recursive: true });
    cpSync(savedBase, olderBase, { recursive: true });
    cpSync(savedPg, olderPg, { recursive: true });
    appendFileSync(join(olderPg, 'postgresql.auto.conf'), "\narchive_mode = off\nrestore_command = 'false'\n");
    writeFileSync(join(olderPg, 'recovery.signal'), '');
    graph = await startFuseki(olderBase, 'older-restore');
    database = await startPg(olderPg, 'older-restore');
    fuseki = graph.fuseki;
    pool = database.pool;
    access = new AccessAdmissionRegistry(pool);
    const olderLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '2' };
    await engageAccessRecoveryFence(pool);
    await cutoverRestoredGraphLineage(fuseki, { prior: { ...oldLineage, sequence: '2' }, next: olderLineage });
    await expect(releaseGraphHold(fuseki, pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '40',
      accessOutboxCount: laterAccessOutbox.count, accessOutboxDigest: laterAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: laterRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(releaseGraphHold(fuseki, pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: externalAccessState.count, accessStateDigest: externalAccessState.digest,
      relay: externalRelay,
    })).rejects.toThrow('relay handoff differs from recovery coverage');
    await expect(releaseGraphHold(fuseki, pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '2',
      accessOutboxCount: externalAccessOutbox.count, accessOutboxDigest: externalAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: externalRelay,
    })).rejects.toThrow('Access state differs from recovery coverage');
    const olderEnv = { ...restoredEnv, fuseki, lineage: olderLineage };
    const heldOlderApp = createMainApp(fuseki, { environment: olderEnv, account, access });
    const laterReplay = await heldOlderApp.handle(new Request('http://localhost/v1/content-edits', {
      method: 'POST', headers: { authorization: bearer,
        'content-type': 'application/json', 'idempotency-key': laterInput.idempotencyKey },
      body: JSON.stringify({ profile: 'metadata-only-v1', work: laterInput.work,
        expectedHead: laterInput.expectedHead, title: laterInput.title, actingSubject: laterInput.actingSubject }),
    }));
    expect(laterReplay.status).toBe(503);
    expect((await laterReplay.json() as { code: string }).code).toBe('recovery_hold');
    expect((await pool.query<{ count: string }>('SELECT count(*) AS count FROM access.admission'))
      .rows[0]!.count).toBe('7');
    await expect(reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      pool, journal.pool, laterRelay, '3')).rejects.toBeInstanceOf(RetainedEffectConflict);
    latestAccess = await startPg(livePg, 'latest-access');
    await expect(reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '3')).rejects.toBeInstanceOf(RetainedEffectConflict);
    const latestFenceGeneration = await engageAccessRecoveryFence(latestAccess.pool);
    await expect(reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: restoreObjects },
      latestAccess.pool, journal.pool, laterRelay, '3')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replay = await reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '3');
    expect(replay.revision).toBe(laterEffect.revision);
    expect(replay.replayed).toBe(false);
    expect((await reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '3')).replayed).toBe(true);
    expect((await heldOlderApp.handle(new Request('http://localhost/health/ready'))).status).toBe(503);
    expect((await heldOlderApp.handle(new Request('http://localhost/health/search-ready'))).status)
      .toBe(503);
    const recoveredRevision = await readExactWorkRevision(
      { ...olderEnv, objectDirectory: liveObjects }, laterEffect.revision, async () => true);
    expect(recoveredRevision.title).toBe('Effect after saved cut');
    expect(recoveredRevision.sourcePosition).toEqual({ datasetId: 'product',
      dataEpoch: oldLineage.dataEpoch, sequence: '3' });
    await expect(releaseGraphHold(fuseki, latestAccess.pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '40',
      accessOutboxCount: laterAccessOutbox.count, accessOutboxDigest: laterAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: laterRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    await expect(reconcileRetainedWorkCreate({ ...olderEnv, objectDirectory: restoreObjects },
      latestAccess.pool, journal.pool, laterRelay, '4')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayCreate = await reconcileRetainedWorkCreate({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '4');
    expect(replayCreate.work).toBe(laterCreate.work);
    expect(replayCreate.workRevision).toBe(laterCreate.workRevision);
    expect(replayCreate.replayed).toBe(false);
    expect((await reconcileRetainedWorkCreate({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '4')).replayed).toBe(true);
    const recoveredCreate = await readExactWorkRevision(
      { ...olderEnv, objectDirectory: liveObjects }, laterCreate.workRevision, async () => true);
    expect(recoveredCreate.title).toBe('Created after saved cut');
    expect(recoveredCreate.sourcePosition).toEqual({ datasetId: 'product',
      dataEpoch: oldLineage.dataEpoch, sequence: '4' });
    await expect(releaseGraphHold(fuseki, latestAccess.pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '40',
      accessOutboxCount: laterAccessOutbox.count, accessOutboxDigest: laterAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: laterRelay,
    })).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '5')).receipt).toBe(cancelledReceipt.receipt);
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '5')).replayed).toBe(true);
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '6')).reason).toBe('stale-head');
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '6')).replayed).toBe(true);
    expect((await reconcileRetainedEmptyBatch(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '7')).batchId).toBe(emptyBatch);
    expect((await reconcileRetainedEmptyBatch(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '7')).replayed).toBe(true);
    await expect(reconcileRetainedContributionDraftCreate(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '8')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayDraft = await reconcileRetainedContributionDraftCreate(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '8');
    expect(replayDraft).toMatchObject({ contribution: laterDraft.contribution,
      draftRevision: laterDraft.draftRevision, replayed: false });
    expect((await reconcileRetainedContributionDraftCreate(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '8')).replayed).toBe(true);
    const recoveredDraft = await readExactContributionDraft(
      { ...olderEnv, objectDirectory: liveObjects }, laterDraft.contribution!,
      laterDraft.draftRevision!, async () => true);
    expect(recoveredDraft.body).toBe(laterDraftInput.body);
    expect(recoveredDraft.sourcePosition).toEqual({ datasetId: 'product',
      dataEpoch: oldLineage.dataEpoch, sequence: '8' });
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '9')).receipt).toBe(cancelledDraftReceipt.receipt);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '9')).replayed).toBe(true);
    await expect(reconcileRetainedContributionDraftEdit(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '10')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayDraftEdit = await reconcileRetainedContributionDraftEdit(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '10');
    expect(replayDraftEdit).toMatchObject({
      draftRevision: laterDraftEdit.draftRevision, replayed: false,
    });
    expect((await reconcileRetainedContributionDraftEdit(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '10')).replayed).toBe(true);
    const recoveredEditedEnv = { ...olderEnv, objectDirectory: liveObjects };
    Object.assign(recoveredEditedEnv, { accessAdmission: new AccessAdmissionRegistry(latestAccess.pool) });
    const recoveredEditedDraft = await readExactContributionDraft(
      recoveredEditedEnv, laterDraft.contribution!,
      laterDraftEdit.draftRevision!, async () => true);
    expect(recoveredEditedDraft.body).toBe(laterDraftEditInput.body);
    expect(recoveredEditedDraft.predecessor).toBe(laterDraft.draftRevision);
    expect(recoveredEditedDraft.sourcePosition).toEqual({ datasetId: 'product',
      dataEpoch: oldLineage.dataEpoch, sequence: '10' });
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '11')).reason).toBe('stale-head');
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '11')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '12')).receipt).toBe(cancelledDraftEditReceipt.receipt);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '12')).replayed).toBe(true);
    await expect(reconcileRetainedContributionPublication(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '13')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayPublication = await reconcileRetainedContributionPublication(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '13');
    expect(replayPublication).toMatchObject({
      publicationDecision: laterPublication.publicationDecision, replayed: false });
    expect((await reconcileRetainedContributionPublication(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '13')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '14')).reason).toBe('stale-head');
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '15')).receipt).toBe(cancelledPublicationReceipt.receipt);
    await expect(reconcileRetainedMainSelection(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '16')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replaySelection = await reconcileRetainedMainSelection(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '16');
    expect(replaySelection).toMatchObject({ selection: laterSelection.selection, replayed: false });
    expect((await reconcileRetainedMainSelection(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '16')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '17')).reason).toBe('stale-head');
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '18')).receipt).toBe(cancelledSelectionReceipt.receipt);
    await expect(reconcileRetainedRealmSpaceCreate(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '19')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replaySpace = await reconcileRetainedRealmSpaceCreate(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '19');
    expect(replaySpace).toMatchObject({ space: laterSpace.space, realm: laterSpace.realm,
      replayed: false });
    expect((await reconcileRetainedRealmSpaceCreate(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '19')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '20')).receipt).toBe(cancelledSpaceReceipt.receipt);
    await expect(reconcileRetainedRealmSelection(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '21')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayRealm = await reconcileRetainedRealmSelection(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '21');
    expect(replayRealm).toMatchObject({ selection: laterRealm.selection, replayed: false });
    expect((await reconcileRetainedRealmSelection(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '21')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '22')).reason).toBe('stale-head');
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '23')).receipt).toBe(cancelledRealmReceipt.receipt);
    await expect(reconcileRetainedRealmRejection(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '24')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayRejection = await reconcileRetainedRealmRejection(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '24');
    expect(replayRejection).toMatchObject({ rejection: laterRejection.rejection,
      replayed: false });
    expect((await reconcileRetainedRealmRejection(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '24')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '25')).reason).toBe('stale-head');
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '26')).receipt).toBe(cancelledRejectionReceipt.receipt);
    await expect(reconcileRetainedClassificationContext(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '27')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayContext = await reconcileRetainedClassificationContext(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '27');
    expect(replayContext).toMatchObject({ context: laterContext.context, replayed: false });
    expect((await reconcileRetainedClassificationContext(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '27')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '28')).receipt).toBe(cancelledContextReceipt.receipt);
    await expect(reconcileRetainedClassificationProposition(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '29')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayProposition = await reconcileRetainedClassificationProposition(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '29');
    expect(replayProposition).toMatchObject({ sense: laterProposition.definitions?.sense,
      replayed: false });
    expect((await reconcileRetainedClassificationProposition(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '29')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '30')).receipt).toBe(cancelledPropositionReceipt.receipt);
    await expect(reconcileRetainedClassificationDecision(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '31')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayGlobalDecision = await reconcileRetainedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '31');
    expect(replayGlobalDecision).toMatchObject({ application: globalDecision.application,
      decision: globalDecision.decision, replayed: false });
    const replayRealmDecision = await reconcileRetainedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '32');
    expect(replayRealmDecision).toMatchObject({ application: realmDecision.application,
      decision: realmDecision.decision, replayed: false });
    const replayRevisedDecision = await reconcileRetainedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '33');
    expect(replayRevisedDecision).toMatchObject({ application: realmDecision.application,
      decision: revisedDecision.decision, replayed: false });
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '34')).receipt).toBe(cancelledDecisionReceipt.receipt);
    await expect(reconcileRetainedRatingContext(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '35')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayRating = await reconcileRetainedRatingContext(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '35');
    expect(replayRating).toMatchObject({ context: laterRating.context, replayed: false });
    expect((await reconcileRetainedRatingContext(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '35')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '36')).receipt).toBe(cancelledRatingReceipt.receipt);
    await expect(reconcileRetainedStandingRating(
      { ...olderEnv, objectDirectory: restoreObjects }, latestAccess.pool,
      journal.pool, laterRelay, '37')).rejects.toBeInstanceOf(RevisionUnavailable);
    const replayObservation = await reconcileRetainedStandingRating(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '37');
    expect(replayObservation).toMatchObject({ observation: laterObservation.observation,
      revision: laterObservation.revision, replayed: false });
    const replayCorrection = await reconcileRetainedStandingRating(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '38');
    expect(replayCorrection).toMatchObject({ observation: laterObservation.observation,
      revision: laterCorrection.revision, replayed: false });
    const replayWithdrawal = await reconcileRetainedStandingRating(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '39');
    expect(replayWithdrawal).toMatchObject({ observation: laterObservation.observation,
      revision: laterWithdrawal.revision, replayed: false });
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '40')).receipt).toBe(cancelledObservationReceipt.receipt);
    expect((await reconcileRetainedWorkEdit({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '3')).replayed).toBe(true);
    expect((await reconcileRetainedWorkCreate({ ...olderEnv, objectDirectory: liveObjects },
      latestAccess.pool, journal.pool, laterRelay, '4')).replayed).toBe(true);
    expect((await reconcileRetainedWorkCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '5')).replayed).toBe(true);
    expect((await reconcileRetainedContributionDraftCreate(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '8')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '9')).replayed).toBe(true);
    expect((await reconcileRetainedContributionDraftEdit(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '10')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '11')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '12')).replayed).toBe(true);
    expect((await reconcileRetainedContributionPublication(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '13')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '14')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '15')).replayed).toBe(true);
    expect((await reconcileRetainedMainSelection(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '16')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '17')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '18')).replayed).toBe(true);
    expect((await reconcileRetainedRealmSpaceCreate(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '19')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '20')).replayed).toBe(true);
    expect((await reconcileRetainedRealmSelection(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '21')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '22')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '23')).replayed).toBe(true);
    expect((await reconcileRetainedRealmRejection(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '24')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '25')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '26')).replayed).toBe(true);
    expect((await reconcileRetainedClassificationContext(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '27')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '28')).replayed).toBe(true);
    expect((await reconcileRetainedClassificationProposition(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '29')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '30')).replayed).toBe(true);
    expect((await reconcileRetainedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '31')).replayed).toBe(true);
    expect((await reconcileRetainedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '32')).replayed).toBe(true);
    expect((await reconcileRetainedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '33')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '34')).replayed).toBe(true);
    expect((await reconcileRetainedRatingContext(
      { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
      journal.pool, laterRelay, '35')).replayed).toBe(true);
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '36')).replayed).toBe(true);
    for (const sequence of ['37', '38', '39']) {
      expect((await reconcileRetainedStandingRating(
        { ...olderEnv, objectDirectory: liveObjects }, latestAccess.pool,
        journal.pool, laterRelay, sequence)).replayed).toBe(true);
    }
    expect((await reconcileRetainedAdmissionCancellation(olderEnv, latestAccess.pool,
      journal.pool, laterRelay, '40')).replayed).toBe(true);
    await releaseGraphHold(fuseki, latestAccess.pool, journal.pool, olderLineage, {
      priorDataEpoch: oldLineage.dataEpoch, priorSequence: '40',
      accessOutboxCount: laterAccessOutbox.count, accessOutboxDigest: laterAccessOutbox.digest,
      accessStateCount: laterAccessState.count, accessStateDigest: laterAccessState.digest,
      relay: laterRelay,
    });
    await releaseAccessRecoveryFence(latestAccess.pool, latestFenceGeneration);
    const recoveredAccess = new AccessAdmissionRegistry(latestAccess.pool);
    const recoveredApp = createMainApp(fuseki, { environment: {
      ...olderEnv, objectDirectory: liveObjects }, account, access: recoveredAccess });
    expect((await recoveredApp.handle(new Request('http://localhost/health/ready'))).status).toBe(200);
    expect((await recoveredApp.handle(new Request('http://localhost/health/search-ready'))).status)
      .toBe(200);
    expect((await editAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterInput)).revision).toBe(laterEffect.revision);
    expect((await createAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterCreateInput)).work).toBe(laterCreate.work);
    expect((await createAdmittedTextContribution({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterDraftInput)).contribution).toBe(laterDraft.contribution);
    expect((await editAdmittedTextContribution({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterDraftEditInput)).draftRevision)
      .toBe(laterDraftEdit.draftRevision);
    expect((await publishAdmittedTextContribution({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterPublicationInput)).publicationDecision)
      .toBe(laterPublication.publicationDecision);
    expect((await selectAdmittedMainDefault({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterSelectionInput)).selection)
      .toBe(laterSelection.selection);
    await expect(selectAdmittedMainDefault({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, staleSelectionInput))
      .rejects.toBeInstanceOf(StaleMainSelection);
    await expect(selectAdmittedMainDefault({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, cancelledSelectionInput))
      .rejects.toThrow('selection was cancelled');
    const recoveredSelectedResponse = await recoveredApp.handle(new Request(
      `http://localhost/v1/main-versions/${created.mainVersion.split('/').at(-1)}/selection`));
    expect(recoveredSelectedResponse.status).toBe(200);
    expect(await recoveredSelectedResponse.json()).toMatchObject({
      body: laterDraftEditInput.body, selection: laterSelection.selection,
    });
    const recoveredSearch = await queryPublicMainPhrase(
      { ...olderEnv, objectDirectory: liveObjects },
      { phrase: 'Retained edited', language: null });
    expect(recoveredSearch).toMatchObject({ complete: true, population: 1 });
    expect(recoveredSearch.results).toEqual([expect.objectContaining({
      matchUnit: laterSelection.matchUnit,
    })]);
    expect((await selectAdmittedRealmLocal({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterRealmInput)).selection).toBe(laterRealm.selection);
    await expect(selectAdmittedRealmLocal({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, staleRealmInput))
      .rejects.toBeInstanceOf(StaleRealmSelection);
    await expect(selectAdmittedRealmLocal({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, cancelledRealmInput))
      .rejects.toThrow('Realm selection was cancelled');
    expect((await rejectAdmittedRealmLocal({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterRejectionInput)).rejection)
      .toBe(laterRejection.rejection);
    await expect(rejectAdmittedRealmLocal({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, staleRejectionInput))
      .rejects.toBeInstanceOf(StaleRealmRejection);
    await expect(rejectAdmittedRealmLocal({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, cancelledRejectionInput))
      .rejects.toThrow('Realm rejection was cancelled');
    const recoveredRealmResponse = await recoveredApp.handle(new Request(
      `http://localhost/v1/realms/${laterSpace.realm!.split('/').at(-1)}/main-versions/${
        created.mainVersion.split('/').at(-1)}/selection`));
    expect(recoveredRealmResponse.status).toBe(200);
    const recoveredSuppression = await recoveredRealmResponse.json();
    expect(recoveredSuppression).toMatchObject({
      realm: laterSpace.realm, effectiveContext: laterSpace.realm,
      status: 'suppressed', reason: 'realm-rejection', rejection: laterRejection.rejection,
    });
    expect('body' in recoveredSuppression).toBe(false);
    const recoveredRealmQuery = await queryPublicRealmPhrase(
      { ...olderEnv, objectDirectory: liveObjects },
      { context: { kind: 'realm-local', id: laterSpace.realm! },
        phrase: 'Retained edited', language: null });
    expect(recoveredRealmQuery).toMatchObject({ complete: true, population: 1,
      total: 0 });
    expect((await createAdmittedRealmSpace({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, laterSpaceInput)).space).toBe(laterSpace.space);
    await expect(createAdmittedRealmSpace({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, cancelledSpaceInput))
      .rejects.toThrow('Space creation was cancelled');
    const recoveredSpaceResponse = await recoveredApp.handle(new Request(
      `http://localhost/v1/spaces/${laterSpace.space!.split('/').at(-1)}`));
    expect(recoveredSpaceResponse.status).toBe(200);
    expect(await recoveredSpaceResponse.json()).toMatchObject({
      space: laterSpace.space, realm: laterSpace.realm,
      name: laterSpaceInput.name, owner: actor,
    });
    const recoveredContextResponse = await recoveredApp.handle(new Request(
      `http://localhost/v1/realms/${laterSpace.realm!.split('/').at(-1)}/classification-context`));
    expect(recoveredContextResponse.status).toBe(200);
    expect(await recoveredContextResponse.json()).toMatchObject({
      realm: laterSpace.realm, context: laterContext.context,
      contextRevision: laterContext.revision,
      fallbackContext: 'urn:rezics:classification-context:global',
    });
    expect((await createAdmittedClassificationContext(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, laterContextInput)).context).toBe(laterContext.context);
    await expect(createAdmittedClassificationContext(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, cancelledContextInput)).rejects.toThrow('classification context creation was cancelled');
    expect((await readClassificationContextReceipt(
      { ...olderEnv, objectDirectory: liveObjects }, cancelledContextAdmission.id))?.outcome)
      .toBe('cancelled');
    const recoveredPropositionResponse = await recoveredApp.handle(new Request(
      `http://localhost/v1/classification-propositions/${laterProposition.definitions!.sense.split('/').at(-1)}`));
    expect(recoveredPropositionResponse.status).toBe(200);
    expect(await recoveredPropositionResponse.json()).toMatchObject({
      ...laterProposition.definitions, label: laterPropositionInput.label,
      definitionRevision: laterProposition.revision,
      interpretationScope: 'urn:rezics:classification-context:global',
    });
    expect((await createAdmittedClassificationProposition(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, laterPropositionInput)).definitions).toEqual(laterProposition.definitions);
    await expect(createAdmittedClassificationProposition(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, cancelledPropositionInput)).rejects.toThrow('classification proposition creation was cancelled');
    expect((await readClassificationPropositionReceipt(
      { ...olderEnv, objectDirectory: liveObjects }, cancelledPropositionAdmission.id))?.outcome)
      .toBe('cancelled');
    const recoveredResolution = await recoveredApp.handle(new Request(
      'http://localhost/v1/classification-resolutions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'classification-resolution-v1',
          context: { kind: 'realm-classification', id: laterSpace.realm },
          work: created.work, mainVersion: created.mainVersion,
          sense: laterProposition.definitions!.sense }),
      }));
    expect(recoveredResolution.status).toBe(200);
    expect(await recoveredResolution.json()).toMatchObject({
      state: 'accepted', source: 'local', decision: revisedDecision.decision,
      application: realmDecision.application });
    expect(await queryPublicMainClassifiedPhrase(
      { ...olderEnv, objectDirectory: liveObjects },
      { phrase: 'Retained edited', language: null,
        sense: laterProposition.definitions!.sense })).toMatchObject({
      complete: true, total: 1,
      results: [{ classification: { source: 'global', decision: globalDecision.decision } }] });
    expect(await queryPublicRealmClassifiedPhrase(
      { ...olderEnv, objectDirectory: liveObjects },
      { phrase: 'Retained edited', language: null,
        context: { kind: 'realm-local', id: laterSpace.realm! },
        sense: laterProposition.definitions!.sense })).toMatchObject({
      complete: true, total: 0, results: [] });
    expect((await setAdmittedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, globalDecisionInput)).decision).toBe(globalDecision.decision);
    expect((await setAdmittedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, realmDecisionInput)).decision).toBe(realmDecision.decision);
    expect((await setAdmittedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, revisedDecisionInput)).decision).toBe(revisedDecision.decision);
    await expect(setAdmittedClassificationDecision(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, cancelledDecisionInput)).rejects.toThrow('classification decision was cancelled');
    expect((await readClassificationDecisionReceipt(
      { ...olderEnv, objectDirectory: liveObjects }, cancelledDecisionAdmission.id))?.outcome)
      .toBe('cancelled');
    const recoveredRatingResponse = await recoveredApp.handle(new Request(
      `http://localhost/v1/rating-contexts/${laterRating.context!.split('/').at(-1)}`));
    expect(recoveredRatingResponse.status).toBe(200);
    expect(await recoveredRatingResponse.json()).toMatchObject({
      context: laterRating.context, realm: laterSpace.realm,
      question: laterRatingInput.question, contextRevision: laterRating.revision,
    });
    expect((await createAdmittedRatingContext(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, laterRatingInput)).context).toBe(laterRating.context);
    await expect(createAdmittedRatingContext(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, cancelledRatingInput)).rejects.toThrow('rating context creation was cancelled');
    expect((await readRatingContextReceipt(
      { ...olderEnv, objectDirectory: liveObjects }, cancelledRatingAdmission.id))?.outcome)
      .toBe('cancelled');
    expect((await setAdmittedStandingRating(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, laterObservationInput)).revision).toBe(laterObservation.revision);
    expect((await setAdmittedStandingRating(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, laterCorrectionInput)).revision).toBe(laterCorrection.revision);
    expect((await setAdmittedStandingRating(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, laterWithdrawalInput)).revision).toBe(laterWithdrawal.revision);
    await expect(setAdmittedStandingRating(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess,
      request, cancelledObservationInput)).rejects.toThrow('standing rating was cancelled');
    expect((await readStandingRatingReceipt(
      { ...olderEnv, objectDirectory: liveObjects }, cancelledObservationAdmission.id))?.outcome)
      .toBe('cancelled');
    expect(await queryStandingRatingAggregate(
      { ...olderEnv, objectDirectory: liveObjects }, {
        context: laterRating.context!, work: created.work,
        mainVersion: created.mainVersion })).toMatchObject({
      population: 1, count: 0, withdrawnCount: 1, mean: null,
      precision: { kind: 'no-data' } });
    expect((await readSpaceCreationReceipt({ ...olderEnv, objectDirectory: liveObjects },
      cancelledSpaceAdmission.id))?.outcome).toBe('cancelled');
    await expect(publishAdmittedTextContribution({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, stalePublicationInput))
      .rejects.toBeInstanceOf(StalePublicationHead);
    await expect(publishAdmittedTextContribution({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, cancelledPublicationInput))
      .rejects.toThrow('publication was cancelled');
    await expect(editAdmittedTextContribution({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, staleDraftEditInput))
      .rejects.toBeInstanceOf(StaleContributionDraftHead);
    await expect(editAdmittedTextContribution({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, cancelledDraftEditInput))
      .rejects.toThrow('Contribution edit was cancelled');
    await expect(createAdmittedTextContribution({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, cancelledDraftInput))
      .rejects.toBeInstanceOf(CancelledActivation);
    await expect(createAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, { actingSubject: actor,
        idempotencyKey: 'new-create-after-closure', title: 'Closed create scope', language: 'en' }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await expect(createAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, cancelledInput)).rejects.toBeInstanceOf(CancelledActivation);
    await expect(editAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, staleInput)).rejects.toBeInstanceOf(StaleWorkHead);
    const newLineageRealmInput = { ...laterRealmInput,
      expectedSelectionHead: laterRejection.rejection!,
      idempotencyKey: 'new-lineage-realm-after-rejection' };
    const newLineageRealm = await selectAdmittedRealmLocal(
      { ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, newLineageRealmInput);
    expect(newLineageRealm.sequence).toBe('1');
    expect(await (await recoveredApp.handle(new Request(
      `http://localhost/v1/realms/${laterSpace.realm!.split('/').at(-1)}/main-versions/${
        created.mainVersion.split('/').at(-1)}/selection`))).json()).toMatchObject({
      reason: 'realm-adoption', selection: newLineageRealm.selection,
      body: laterDraftEditInput.body });
    expect(await queryPublicRealmPhrase({ ...olderEnv, objectDirectory: liveObjects },
      { context: { kind: 'realm-local', id: laterSpace.realm! },
        phrase: 'Retained edited', language: null })).toMatchObject({
      complete: true, population: 2, total: 1,
      results: [{ matchUnit: newLineageRealm.matchUnit }] });
    expect(await queryPublicRealmClassifiedPhrase(
      { ...olderEnv, objectDirectory: liveObjects },
      { context: { kind: 'realm-local', id: laterSpace.realm! },
        phrase: 'Retained edited', language: null,
        sense: laterProposition.definitions!.sense })).toMatchObject({
      complete: true, population: 2, total: 1,
      results: [{ matchUnit: newLineageRealm.matchUnit,
        classification: { source: 'local', decision: revisedDecision.decision } }] });
    const joinedInput = { context: { kind: 'realm-local' as const,
      id: laterSpace.realm! }, phrase: 'Retained edited', language: null,
      sense: laterProposition.definitions!.sense,
      ratingContext: laterRating.context!, minimumMeanTimes10: 80 };
    expect(await queryPublicRealmClassifiedRatedPhrase(
      { ...olderEnv, objectDirectory: liveObjects }, joinedInput)).toMatchObject({
      complete: true, population: 2, ratingPopulation: 1, total: 0,
      sourcePosition: { dataEpoch: olderLineage.dataEpoch, sequence: '1' } });
    const postReplayInput = { work: created.work, expectedHead: laterEffect.revision,
      title: 'New lineage after replay', actingSubject: actor, idempotencyKey: 'new-lineage-after-replay' };
    expect((await editAdmittedMetadataWork({ ...olderEnv, objectDirectory: liveObjects },
      account, recoveredAccess, request, postReplayInput)).sequence).toBe('2');
    const recoveredRestoration = await setAdmittedStandingRating(
      { ...olderEnv, objectDirectory: liveObjects }, account, recoveredAccess, request,
      { ...laterObservationInput, expectedRevisionHead: laterWithdrawal.revision!,
        value: 8, idempotencyKey: 'new-lineage-standing-rating-restoration' });
    expect(recoveredRestoration.sequence).toBe('3');
    expect(await queryPublicRealmClassifiedRatedPhrase(
      { ...olderEnv, objectDirectory: liveObjects }, joinedInput)).toMatchObject({
      complete: true, population: 2, ratingPopulation: 1, total: 1,
      sourcePosition: { dataEpoch: olderLineage.dataEpoch, sequence: '3' },
      results: [{ matchUnit: newLineageRealm.matchUnit,
        classification: { source: 'local', decision: revisedDecision.decision },
        rating: { count: 1, sum: 8, mean: 8 } }] });
  } finally {
    await accountApp?.stop();
    await Promise.allSettled(pools.map(pool => pool.end()));
    const removed = await Promise.allSettled([...restoredContainers].map(async container =>
      docker(['rm', '-f', container], 65_000)));
    for (const result of removed) if (result.status === 'rejected') console.error(result.reason);
    if (started) {
      const reset = execFileSync('bun', ['scripts/dev/cli.ts', 'stack:reset', ...stackArgs],
        { cwd: root, env: dockerEnv, encoding: 'utf8', timeout: 90_000 });
      if (reset.trim()) console.log(reset.trim());
    }
    if (restoredContainers.size > 0) {
      // Restore containers own these scratch bytes; give the worktree user its
      // directory back only after every server has been stopped.
      docker(['run', '--rm', '--network', 'none', '--user', '0:0',
        '--volume', `${state}:/recovery`, '--entrypoint', 'sh', postgresImage!, '-ec',
        `chown -R ${process.getuid!()}:${process.getgid!()} /recovery`]);
    }
    rmSync(state, { recursive: true, force: true });
  }
}, qaStartupTestTimeout(180_000));
