import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { installConsentRefreshFence } from '../../../services/account/src/consent-fence.ts';
import { assertDeletionRecoverySet, captureDeletionRecoverySet } from
  '../../../services/account/src/deletion-recovery-set.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { publishAdmittedContent } from '../../../services/main/src/modules/content-publication/publish-admitted.ts';
import { GRAPHS, RV, initializeFreshGraph, type WorkActivationEnvironment } from
  '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { assertGraphAdmissionOpen, captureGraphRecoveryCoverage,
  cutoverRestoredGraphLineage, RecoveryHold, releaseRestoredGraphHold } from
  '../../../services/main/src/modules/work/restore-lineage.ts';
import { assertAccountDeletionJournalCoverage, mirrorAccountDeletionIntent } from
  '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { assertAccountSubjectDeletionsAbsent, retainAccountSubjectDeletion } from
  '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from
  '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from
  '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'b7'.repeat(32);

function rootCommand(args: string[], timeout: number): string {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
  return result.stdout.trim();
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no fixture port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function migrate(pool: Pool, owner: 'access' | 'relay'): Promise<void> {
  const directory = join(root, `services/main/migrations/${owner}`);
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
  }
}

test('IAM11/OPS03: deletion frontiers preserve unrelated public Work and Content', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `owner-cut-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const stackArgs = ['--profile', 'qa', '--run-id', runId];
  const state = join(root, '.temp', `account-erasure-${randomUUID()}`);
  const socketDirectory = join(root, '.temp', 's');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const pools: Pool[] = [];
  const replayData: string[] = [];
  let app: ReturnType<typeof createAccountApp> | undefined;
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const stack = stackDirectory(root, { profile: 'qa', runId });
    const apps = readEnv(join(stack, 'apps.env'));
    const compose = readEnv(join(stack, 'compose.env'));
    const account = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
    const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    const relay = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    const owner = (database: string) => new Pool({ connectionString:
      `postgresql://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}`
        + `@127.0.0.1:${compose.POSTGRES_PORT}/${database}` });
    const accountOwner = owner('account');
    const accessOwner = owner('access');
    pools.push(account, access, contentPool, relay, accountOwner, accessOwner);
    await migrate(access, 'access');
    await migrate(relay, 'relay');
    await migrateContent(contentPool);
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const issuer = `${baseURL}/api/auth`;
    const registry = new AccessAdmissionRegistry(access);
    const operators = new Set<string>();
    const config = { baseURL, secret: apps.ACCOUNT_SECRET!,
      resource: apps.ACCOUNT_MAIN_RESOURCE!, pool: account,
      operatorUserIds: operators,
      accessDeletionFence: async (subject: string) => {
        const fence = await registry.strongDeactivateAccountSubject(issuer, subject);
        if (fence) await mirrorAccountDeletionIntent(
          access, relay, fence.principalId, fence.enforcementEpoch);
        await retainAccountSubjectDeletion(relay, issuer, subject);
      } };
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    await installConsentRefreshFence(account);
    const auth = createAccountAuth(config);
    app = createAccountApp(auth, account)
      .listen({ hostname: '127.0.0.1', port });
    const signUp = async (name: string) => {
      const email = `${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${baseURL}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
        body: JSON.stringify({ name, email, password }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        cookie: response.headers.get('set-cookie')!, password };
    };
    const deleted = await signUp('deleted');
    const unaffected = await signUp('unaffected');
    operators.add(unaffected.id);
    const principalId = randomUUID();
    await access.query(
      'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, issuer, deleted.id]);
    const privateRows = async (pool: Pool, subject: string) => {
      const result = await pool.query<{ users: string; passwords: string; sessions: string }>(
        `SELECT (SELECT count(*) FROM "user" WHERE id = $1)::text AS users,
          (SELECT count(*) FROM "account" WHERE "userId" = $1)::text AS passwords,
          (SELECT count(*) FROM "session" WHERE "userId" = $1)::text AS sessions`,
        [subject]);
      return result.rows[0];
    };
    expect(await privateRows(account, deleted.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const initial = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    await initializeFreshGraph(fuseki, initial);
    const adminHeaders = new Headers({ cookie: unaffected.cookie, origin: baseURL });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Erasure recovery verifier', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const browserClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Erasure recovery browser', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create work:edit',
        skip_consent: true, require_pkce: true } });
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${baseURL}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: browserClient.client_id, redirect_uri: redirectUri,
      scope: 'openid work:create work:edit', state: randomUUID(),
      resource: apps.ACCOUNT_MAIN_RESOURCE!,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
    const authorized = await fetch(authorize, {
      headers: { cookie: unaffected.cookie }, redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code');
    if (!code) throw new Error('OAuth authorization code is absent');
    const exchange = await fetch(`${baseURL}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code',
        client_id: browserClient.client_id, code, redirect_uri: redirectUri,
        code_verifier: verifier, resource: apps.ACCOUNT_MAIN_RESOURCE! }) });
    expect(exchange.status).toBe(200);
    const bearer = `Bearer ${(await exchange.json() as { access_token: string }).access_token}`;
    const verifierAccount = new AccountAssertionVerifier({ issuer, audience: apps.ACCOUNT_MAIN_RESOURCE!,
      jwksUrl: `${baseURL}/api/auth/jwks`,
      introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    const request = new Request('https://main.rezics.test/v1/works', {
      headers: { authorization: bearer } });
    expect(await verifierAccount.verify(request, ['work:create']))
      .toEqual({ issuer, subject: unaffected.id });
    const publicPrincipal = randomUUID();
    const publicActor = `https://rezics.com/id/${randomUUID()}`;
    await access.query(
      'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [publicPrincipal, issuer, unaffected.id]);
    await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')",
      [publicActor]);
    const grant = async (scope: string, action: string) => {
      await access.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
        [scope]);
      await access.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), publicPrincipal, publicActor, action]);
      await access.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), publicActor, scope, action]);
    };
    await grant('work:create:root', 'work.create');
    const environment: WorkActivationEnvironment = { fuseki, lineage: initial,
      objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
    const publicTitle = 'Unrelated public Work survives Account erasure';
    const publicWork = await createAdmittedMetadataWork(environment,
      verifierAccount, registry, request, {
        title: publicTitle, actingSubject: publicActor,
        idempotencyKey: `erasure-public-work-${randomUUID()}` });
    expect(publicWork.sequence).toBe('1');
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const content = new ContentCore(contentPool);
    const publicBody = JSON.stringify({ body: 'Public Content survives Account erasure' });
    const saved = await content.saveDraft({ operationId: `erasure-content-${randomUUID()}`,
      variant: { id: variantId, resourceId: publicWork.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'account-erasure-public-survival' }, serializedJson: publicBody });
    if (saved.outcome !== 'succeeded' || !saved.revisionId) {
      throw new Error('Content owner did not save the public revision');
    }
    const publicRevision = saved.revisionId;
    const exactBefore = (await content.readExactBatch([publicRevision],
      async ids => new Set(ids)))[0];
    if (exactBefore?.status !== 'available') throw new Error('public Content bytes are unavailable');
    expect(exactBefore.serializedJson).toBe(publicBody);
    await grant(`content:publish:${variantId}`, 'content.publish');
    const publication = await publishAdmittedContent(environment, content,
      verifierAccount, registry, request, {
        preparationId: `erasure-publish-${randomUUID()}`, revisionId: publicRevision,
        expectedDigest: exactBefore.reference.byteDigest,
        expectedContentEpoch: saved.position.dataEpoch,
        resourceId: publicWork.work, variantId, expectedPublicationHead: null,
        actingSubject: publicActor, idempotencyKey: `erasure-publish-${randomUUID()}` });
    if (publication.status !== 'active' || !publication.decision || !publication.graphSequence) {
      throw new Error('public Content publication did not return an active graph decision');
    }
    expect(publication.graphSequence).toBe('2');
    const publicGraph = () => fuseki.query(`PREFIX rv: <${RV}>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ASK {
        GRAPH <${GRAPHS.current}> {
          <${publicWork.work}> rdfs:label ${JSON.stringify(publicTitle)}@en .
          <${variantId}> rv:contentPublicationHead <${publication.decision}> . }
        GRAPH <${GRAPHS.revisions}> {
          <${publication.decision}> rv:contentRevision
            <urn:rezics:content:revision:${publicRevision}> . }
      }`);
    expect((await publicGraph()).boolean).toBe(true);
    const consumerBefore = `erasure-before-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumerBefore, initial.dataEpoch);
    expect((await relayMainOutboxOnce(fuseki, relay, consumerBefore))?.sequence).toBe('1');
    expect((await relayMainOutboxOnce(fuseki, relay, consumerBefore))?.sequence).toBe('2');

    const capture = async (consumer: string) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { return await captureGraphRecoveryCoverage(fuseki, accountOwner,
          access, relay, consumer, contentPool); }
        catch (error) {
          if (attempt === 4 || !String(error).includes('Account WAL frontier')) throw error;
          await Bun.sleep(200);
        }
      }
      throw new Error('Account recovery capture did not stabilize');
    };
    const restore = async (backup: string, name: string) => {
      const data = join(state, name);
      replayData.push(data);
      cpSync(backup, data, { recursive: true });
      appendFileSync(join(data, 'postgresql.auto.conf'),
        "\narchive_mode = off\nrestore_command = 'false'\n");
      writeFileSync(join(data, 'recovery.signal'), '');
      const replayPort = await freePort();
      execFileSync('pg_ctl', ['-D', data, '-l', join(state, `${name}.log`),
        '-o', `-h 127.0.0.1 -p ${replayPort} -k ${socketDirectory}`,
        '-t', '20', '-w', 'start'], { cwd: state, timeout: 25_000 });
      const restored = (database: string) => new Pool({ host: '127.0.0.1',
        port: replayPort, database, user: 'postgres', password: compose.POSTGRES_PASSWORD! });
      const restoredAccount = restored('account');
      const restoredAccess = restored('access');
      const restoredContent = restored('content');
      pools.push(restoredAccount, restoredAccess, restoredContent);
      expect((await restoredAccount.query<{ recovering: boolean }>(
        'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering).toBe(false);
      return { account: restoredAccount, access: restoredAccess, content: restoredContent };
    };

    // A source backup predating deletion is a readable but unsafe recovery cut.
    const firstFence = await engageAccessRecoveryFence(access);
    const before = await capture(consumerBefore);
    expect(before).toMatchObject({ priorSequence: '2',
      content: { dataEpoch: saved.position.dataEpoch } });
    expect(Number(before.content?.graphReferencesCount)).toBeGreaterThan(0);
    const firstLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(fuseki, {
      prior: { ...initial, sequence: publication.graphSequence }, next: firstLineage });
    const oldBackup = rootCommand(['stack:backup', ...stackArgs], 100_000);
    execFileSync('pg_verifybackup', ['--no-parse-wal', oldBackup],
      { cwd: state, timeout: 15_000 });
    const old = await restore(oldBackup, 'older');
    const beforeEnvelope = JSON.stringify(sealRecoveryPayload(
      before, recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, beforeEnvelope, recoveryKey);
    await releaseRestoredGraphHold(fuseki, old.access, relay, firstLineage, {
      sealedCoverage: beforeEnvelope, hmacKey: recoveryKey,
      accountPool: old.account, contentPool: old.content });
    await releaseAccessRecoveryFence(old.access, firstFence);
    await releaseAccessRecoveryFence(access, firstFence);
    expect((await publicGraph()).boolean).toBe(true);
    const oldPublicContent = new ContentCore(old.content);
    expect((await oldPublicContent.readExactBatch([publicRevision],
      async ids => new Set(ids)))[0]).toMatchObject({ status: 'available',
      serializedJson: publicBody, reference: { resourceId: publicWork.work,
        variantId, revisionId: publicRevision } });

    const deletion = await fetch(`${baseURL}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        cookie: deleted.cookie, origin: baseURL },
      body: JSON.stringify({ password: deleted.password }),
    });
    expect(deletion.status).toBe(200);
    expect(await privateRows(account, deleted.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await privateRows(account, unaffected.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    expect((await access.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(false);
    expect((await access.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [publicPrincipal])).rows[0]?.active).toBe(true);
    expect(await verifierAccount.verify(request, ['work:create']))
      .toEqual({ issuer, subject: unaffected.id });
    expect((await publicGraph()).boolean).toBe(true);
    expect((await content.readExactBatch([publicRevision],
      async ids => new Set(ids)))[0]).toMatchObject({ status: 'available',
      serializedJson: publicBody });
    await expect(assertAccountDeletionJournalCoverage(access, relay)).resolves.toBeUndefined();
    await expect(assertAccountSubjectDeletionsAbsent(accountOwner, relay)).resolves.toBeUndefined();
    await app.stop();
    app = undefined;

    const finalFence = await engageAccessRecoveryFence(access);
    const consumerAfter = `erasure-after-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumerAfter, firstLineage.dataEpoch);
    const after = await capture(consumerAfter);
    expect(after).toMatchObject({ priorSequence: '0',
      content: { dataEpoch: saved.position.dataEpoch } });
    expect(Number(after.content?.graphReferencesCount)).toBeGreaterThan(0);
    const set = await captureDeletionRecoverySet(accountOwner, accessOwner, issuer, deleted.id);
    const sealedSet = JSON.stringify(sealRecoveryPayload(set,
      recoveryKey, 'deletion-recovery-set'));
    const finalLineage = { dataEpoch: randomUUID(), routingEpoch: '3' };
    await cutoverRestoredGraphLineage(fuseki, {
      prior: { ...firstLineage, sequence: '0' }, next: finalLineage });
    const finalBackup = rootCommand(['stack:backup', ...stackArgs], 100_000);
    execFileSync('pg_verifybackup', ['--no-parse-wal', finalBackup],
      { cwd: state, timeout: 15_000 });
    const current = await restore(finalBackup, 'current');
    const currentPublicContent = new ContentCore(current.content);
    expect((await currentPublicContent.readExactBatch([publicRevision],
      async ids => new Set(ids)))[0]).toMatchObject({ status: 'available',
      serializedJson: publicBody, reference: { resourceId: publicWork.work,
        variantId, revisionId: publicRevision } });
    expect((await publicGraph()).boolean).toBe(true);
    expect(await privateRows(old.account, deleted.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    expect(await privateRows(current.account, deleted.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await privateRows(current.account, unaffected.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    expect((await old.access.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(true);
    expect((await current.access.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(false);
    expect((await current.access.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [publicPrincipal])).rows[0]?.active).toBe(true);
    await expect(assertAccountSubjectDeletionsAbsent(old.account, relay))
      .rejects.toThrow('retained Account deletion subject exists in restored Account');
    await expect(assertAccountDeletionJournalCoverage(old.access, relay))
      .rejects.toThrow('retained Account deletion journal differs from Access');
    await expect(assertDeletionRecoverySet(old.account, current.access, set)).rejects.toThrow();
    await expect(assertDeletionRecoverySet(current.account, old.access, set)).rejects.toThrow();
    await expect(assertDeletionRecoverySet(current.account, current.access, set))
      .resolves.toBeUndefined();

    const envelope = JSON.stringify(sealRecoveryPayload(
      after, recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, envelope, recoveryKey);
    await engageAccessRecoveryFence(old.access);
    await expect(releaseRestoredGraphHold(fuseki, old.access, relay, finalLineage, {
      sealedCoverage: envelope, hmacKey: recoveryKey,
      accountPool: current.account, contentPool: current.content,
      deletions: { accountPool: current.account, hmacKey: recoveryKey,
        sealedSets: [sealedSet] } })).rejects.toThrow('Access outbox differs from recovery coverage');
    await expect(releaseRestoredGraphHold(fuseki, current.access, relay, finalLineage, {
      sealedCoverage: envelope, hmacKey: recoveryKey,
      accountPool: old.account, contentPool: current.content,
      deletions: { accountPool: old.account, hmacKey: recoveryKey,
        sealedSets: [sealedSet] } })).rejects.toThrow('Account WAL differs from recovery coverage');
    await expect(releaseRestoredGraphHold(fuseki, current.access, relay, finalLineage, {
      sealedCoverage: envelope, hmacKey: recoveryKey,
      accountPool: current.account, contentPool: current.content,
    })).rejects.toThrow('Account deletion recovery evidence is incomplete');
    await expect(assertGraphAdmissionOpen(fuseki, finalLineage))
      .rejects.toBeInstanceOf(RecoveryHold);
    await releaseRestoredGraphHold(fuseki, current.access, relay, finalLineage, {
      sealedCoverage: envelope, hmacKey: recoveryKey,
      accountPool: current.account, contentPool: current.content,
      deletions: { accountPool: current.account, hmacKey: recoveryKey,
        sealedSets: [sealedSet] } });
    await releaseAccessRecoveryFence(current.access, finalFence);
    await expect(assertGraphAdmissionOpen(fuseki, finalLineage)).resolves.toBeUndefined();
    expect(await privateRows(current.account, deleted.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect((await publicGraph()).boolean).toBe(true);
  } finally {
    await app?.stop();
    await Promise.allSettled(pools.map(pool => pool.end()));
    for (const data of replayData) {
      if (spawnSync('pg_ctl', ['-D', data, 'status'], { cwd: state, timeout: 5_000 }).status === 0) {
        execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-t', '10', '-w', 'stop'],
          { cwd: state, timeout: 15_000 });
      }
    }
    try { if (started) rootCommand(['stack:reset', ...stackArgs], 120_000); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
}, 300_000);
