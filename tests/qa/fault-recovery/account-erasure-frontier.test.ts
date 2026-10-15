import { enrollOperatorAt } from '../../../services/account/tests/factor-fixture.ts';
import { qaStartupTestTimeout, runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { copyRecoveryTree } from '../support/recovery-copy.ts';
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
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { OwnerOperations, type RestoreResources } from '../../../services/main/src/modules/owner/operations.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { publishAdmittedContent } from '../../../services/main/src/modules/content-publication/publish-admitted.ts';
import { GRAPHS, RV, initializeFreshGraph, type WorkActivationEnvironment } from
  '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { assertGraphAdmissionOpen, captureGraphRecoveryCoverage,
  cutoverRestoredGraphLineage, readRestoredGraphReleaseExpectation, readRestoredGraphReleaseProof,
  RecoveryHold } from
  '../../../services/main/src/modules/work/restore-lineage.ts';
import { assertAccountDeletionJournalCoverage, mirrorAccountDeletionIntent } from
  '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { assertAccountSubjectDeletionsAbsent, retainAccountSubjectDeletion } from
  '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from
  '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from
  '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { retainErasureCoverage } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { heldErasureMaintenanceClient } from '../../../services/main/src/modules/erasure/graph.ts';
import { settleAccountErasures } from '../../../services/main/src/modules/erasure/account.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'b7'.repeat(32);

async function rootCommand(args: string[], timeout: number): Promise<string> {
  const result = await runQaAdmissionChildAsync(root, ...scriptCommand(args), timeout);
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
  for (const file of schemaFiles(root, owner)) {
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
    await rootCommand(['stack:up', ...stackArgs], 180_000);
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
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        cookie: response.headers.get('set-cookie')!, password };
    };
    const deleted = await signUp('deleted');
    const unaffected = await signUp('unaffected');
    operators.add(unaffected.id);
    await enrollOperatorAt(account, config.secret, baseURL, unaffected);
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
    const bearer = `Bearer ${(await signIn({
      account: baseURL, clientId: browserClient.client_id, redirectUri,
      scope: 'openid work:create work:edit', resource: apps.ACCOUNT_MAIN_RESOURCE!,
    }, unaffected.cookie)).accessToken}`;
    const verifierAccount = new AccountAssertionVerifier({ issuer, audience: apps.ACCOUNT_MAIN_RESOURCE!,
      jwksUrl: `${baseURL}/api/auth/jwks`,
      introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    const request = new Request('https://main.rezics.test/v1/works', {
      headers: { authorization: bearer } });
    const expectedUnaffectedAccount = { issuer, subject: unaffected.id, accountAuthMode: 'trusted',
      accountExpiresAt: JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString()).exp,
      accountAudiences: [apps.ACCOUNT_MAIN_RESOURCE!, `${baseURL}/api/auth/oauth2/userinfo`],
      accountClientId: browserClient.client_id, accountConsentGeneration: undefined,
      accountConsentId: undefined, accountScopes: ['openid', 'work:create', 'work:edit'],
      currentAssertion: expect.any(Function) };
    expect(await verifierAccount.verify(request, ['work:create']))
      .toEqual(expectedUnaffectedAccount);
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
        title: publicTitle, language: 'en', actingSubject: publicActor,
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
    await grant(`work:read:${publicWork.work}`, 'work.read');
    await grant(`content:publish:${publicWork.work}`, 'content.publish');
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

    const objectStore = { directory: apps.MAIN_OBJECT_DIRECTORY! };
    const capture = async (consumer: string) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { return await captureGraphRecoveryCoverage(fuseki, accountOwner,
          access, relay, consumer, contentPool, objectStore); }
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
      copyRecoveryTree(backup, data);
      appendFileSync(join(data, 'postgresql.auto.conf'),
        "\narchive_mode = off\nrestore_command = 'false'\n");
      writeFileSync(join(data, 'recovery.signal'), '');
      const replayPort = await freePort();
      const log = join(state, `${name}.log`);
      try {
        // Initial fsync of the copied physical backup can exceed 20 seconds
        // on the shared QA host. Keep readiness bounded without skipping sync.
        execFileSync('pg_ctl', ['-D', data, '-l', log,
          '-o', `-h 127.0.0.1 -p ${replayPort} -k ${socketDirectory}`,
          '-t', '60', '-w', 'start'], { cwd: state, timeout: 65_000 });
      } catch (error) {
        throw new Error(`Restored PostgreSQL failed to start:\n${readFileSync(log, 'utf8').slice(-8_000)}`,
          { cause: error });
      }
      const restored = (database: string) => new Pool({ host: '127.0.0.1',
        port: replayPort, database, user: 'postgres', password: compose.POSTGRES_PASSWORD! });
      const restoredAccount = restored('account');
      const restoredAccess = restored('access');
      const restoredContent = restored('content');
      const restoredRelay = restored('relay');
      pools.push(restoredAccount, restoredAccess, restoredContent, restoredRelay);
      let recovering = true;
      for (let attempt = 0; attempt < 100 && recovering; attempt += 1) {
        recovering = (await restoredAccount.query<{ recovering: boolean }>(
          'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering ?? true;
        if (recovering) await Bun.sleep(100);
      }
      expect(recovering).toBe(false);
      return { account: restoredAccount, access: restoredAccess, content: restoredContent,
        relay: restoredRelay };
    };

    type RestoreAuthority = NonNullable<RestoreResources['erasures']>['authority'];
    const restoreOperator = (owners: { account: Pool; access: Pool; content: Pool; relay?: Pool },
      lineage: { dataEpoch: string; routingEpoch: string }, authority?: RestoreAuthority) => {
      const resources: RestoreResources = {
        accountPool: owners.account,
        accessPool: owners.access,
        contentPool: owners.content,
        ...(owners.relay ? { restoredRelayPool: owners.relay } : {}),
        objectStore,
        hmacKey: recoveryKey,
        ...(authority ? { erasures: {
          authority,
          signingKey: compose.FUSEKI_TITLE_ADMISSION_KEY!,
          maintenance: heldErasureMaintenanceClient(apps.FUSEKI_URL!,
            compose.FUSEKI_MAINTENANCE_TOKEN!),
          originalSource: 'retained-native-event' as const,
        } } : {}),
      };
      const operations = new OwnerOperations(relay,
        { fuseki, lineage, objectDirectory: objectStore.directory }, resources);
      const operatorApp = createMainApp(fuseki, { ownerOperations: operations,
        account: { verify: async (request: Request, scopes: readonly string[]) => {
          if (request.headers.get('authorization') !== bearer || scopes[0] !== 'owner:operate') {
            throw new Error('operator assertion denied');
          }
          return { issuer, subject: unaffected.id };
        } }, access: new AccessAdmissionRegistry(owners.access) } as MainWorkDependencies);
      const request = (key: string, sealedCoverage: string, sealedSets: string[] = []) =>
        operatorApp.handle(new Request('http://main.local/v1/owners/reconciliations', {
          method: 'POST', headers: { authorization: bearer, 'content-type': 'application/json',
            'idempotency-key': key },
          body: JSON.stringify({ profile: 'owner-reconciliation-v1', kind: 'restore',
            sealedCoverage, sealedDeletionSets: sealedSets }),
        }));
      return { request };
    };
    const expectHeldRestore = async (input: { response: Response; key: string; access: Pool;
      lineage: { dataEpoch: string; routingEpoch: string }; reason: string; owner: string }) => {
      expect(input.response.status).toBe(201);
      expect(await input.response.json()).toMatchObject({ state: 'held', disposition: 'conflict' });
      const operationId = `owner:reconcile:${input.key}`;
      const held = await relay.query<{ state: string; hold_reason: string | null }>(
        'SELECT state, hold_reason FROM relay.owner_reconciliation WHERE operation_id = $1',
        [operationId]);
      expect(held.rows).toEqual([{ state: 'held', hold_reason: input.reason }]);
      const findings = await relay.query<{ owner: string; item_kind: string;
        item_ref: string; disposition: string }>(`SELECT owner, item_kind, item_ref, disposition
          FROM relay.owner_reconciliation_item WHERE reconciliation_id = (
            SELECT id FROM relay.owner_reconciliation WHERE operation_id = $1)`, [operationId]);
      expect(findings.rows).toEqual([{ owner: input.owner, item_kind: 'receipt',
        item_ref: 'urn:rezics:dataset:product', disposition: 'conflict' }]);
      expect((await input.access.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]?.open).toBe(false);
      await expect(assertGraphAdmissionOpen(fuseki, input.lineage))
        .rejects.toBeInstanceOf(RecoveryHold);
    };
    const expectNativeRelease = async (lineage: { dataEpoch: string; routingEpoch: string },
      coverage: Awaited<ReturnType<typeof capture>>) => {
      const expectation = await readRestoredGraphReleaseExpectation(fuseki, lineage, coverage);
      const proof = await readRestoredGraphReleaseProof(fuseki, expectation);
      expect(proof).toMatchObject({ expectation,
        receipt: { id: expect.stringMatching(/^urn:rezics:receipt:restore-release:/),
          dataEpoch: lineage.dataEpoch, sequence: '0' } });
    };

    // A source backup predating deletion is a readable but unsafe recovery cut.
    const firstFence = await engageAccessRecoveryFence(access);
    const before = await capture(consumerBefore);
    expect(before).toMatchObject({ priorSequence: '2',
      content: { dataEpoch: saved.position.dataEpoch } });
    expect(Number(before.content?.graphReferencesCount)).toBeGreaterThan(0);
    const beforeEnvelope = JSON.stringify(sealRecoveryPayload(
      before, recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, beforeEnvelope, recoveryKey);
    const beforeErasureEpoch = await retainErasureCoverage(relay, consumerBefore);
    const retainedBefore = await relay.query<{ erasure_epoch: string | null }>(
      'SELECT erasure_epoch::text AS erasure_epoch FROM relay.recovery_coverage_head WHERE consumer = $1',
      [consumerBefore]);
    expect(retainedBefore.rows[0]?.erasure_epoch).toBe(beforeErasureEpoch);
    const firstLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(fuseki, {
      prior: { ...initial, sequence: publication.graphSequence }, next: firstLineage });
    const oldBackup = await rootCommand(['stack:backup', ...stackArgs], 100_000);
    execFileSync('pg_verifybackup', ['--no-parse-wal', oldBackup],
      { cwd: state, timeout: 15_000 });
    const old = await restore(oldBackup, 'older');
    const missingCaptureKey = `missing-current-capture-${randomUUID()}`;
    const unconfigured = restoreOperator(old, firstLineage);
    await expectHeldRestore({ response: await unconfigured.request(missingCaptureKey, beforeEnvelope),
      key: missingCaptureKey, access: old.access, lineage: firstLineage,
      reason: 'retained erasure reconciliation lacks the retained current capture', owner: 'relay' });
    const oldRestoreKey = `before-delete-restore-${randomUUID()}`;
    const oldOperator = restoreOperator(old, firstLineage,
      { sealedCoverage: beforeEnvelope, hmacKey: recoveryKey });
    const oldResponse = await oldOperator.request(oldRestoreKey, beforeEnvelope);
    expect(oldResponse.status).toBe(201);
    expect(await oldResponse.json()).toMatchObject({ state: 'reconciled', disposition: 'matched' });
    expect((await old.access.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0])
      .toEqual({ open: true, generation: (BigInt(firstFence) + 1n).toString() });
    await expect(assertGraphAdmissionOpen(fuseki, firstLineage)).resolves.toBeUndefined();
    await expectNativeRelease(firstLineage, before);
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
      .toEqual(expectedUnaffectedAccount);
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
    const envelope = JSON.stringify(sealRecoveryPayload(
      after, recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, envelope, recoveryKey);
    const afterErasureEpoch = await retainErasureCoverage(relay, consumerAfter);
    const retainedAfter = await relay.query<{ erasure_epoch: string | null }>(
      'SELECT erasure_epoch::text AS erasure_epoch FROM relay.recovery_coverage_head WHERE consumer = $1',
      [consumerAfter]);
    expect(retainedAfter.rows[0]?.erasure_epoch).toBe(afterErasureEpoch);
    expect(await settleAccountErasures(relay, access, accountOwner, 100, contentPool)).toBe(1);
    const settledAccountErasure = await relay.query<{ stage: string; suppression_status: string }>(
      `SELECT stage, suppression_status FROM relay.erasure
       WHERE kind = 'account' AND account_issuer = $1 AND account_subject = $2`, [issuer, deleted.id]);
    expect(settledAccountErasure.rows).toEqual([{ stage: 'inventory_complete',
      suppression_status: 'suppressed' }]);
    const set = await captureDeletionRecoverySet(accountOwner, accessOwner, issuer, deleted.id);
    const sealedSet = JSON.stringify(sealRecoveryPayload(set,
      recoveryKey, 'deletion-recovery-set'));
    const finalLineage = { dataEpoch: randomUUID(), routingEpoch: '3' };
    await cutoverRestoredGraphLineage(fuseki, {
      prior: { ...firstLineage, sequence: '0' }, next: finalLineage });
    const finalBackup = await rootCommand(['stack:backup', ...stackArgs], 100_000);
    execFileSync('pg_verifybackup', ['--no-parse-wal', finalBackup],
      { cwd: state, timeout: 15_000 });
    // Release the source's capture fence after its signed owner cut is backed up.
    // The restored candidate retains its own fence until owner composition releases it.
    await releaseAccessRecoveryFence(access, finalFence);
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

    await engageAccessRecoveryFence(old.access);
    const accessMismatchKey = `access-mismatch-${randomUUID()}`;
    const accessMismatchOperator = restoreOperator({ account: current.account, access: old.access,
      content: current.content, relay: current.relay }, finalLineage,
    { sealedCoverage: envelope, hmacKey: recoveryKey });
    await expectHeldRestore({ response: await accessMismatchOperator.request(
      accessMismatchKey, envelope, [sealedSet]), key: accessMismatchKey, access: old.access,
      lineage: finalLineage, reason: 'Access outbox differs from recovery coverage', owner: 'access' });

    const accountWalMismatchKey = `account-wal-mismatch-${randomUUID()}`;
    const accountWalMismatchOperator = restoreOperator({ account: old.account, access: current.access,
      content: current.content, relay: current.relay }, finalLineage,
    { sealedCoverage: envelope, hmacKey: recoveryKey });
    await expectHeldRestore({ response: await accountWalMismatchOperator.request(
      accountWalMismatchKey, envelope, [sealedSet]), key: accountWalMismatchKey,
      access: current.access, lineage: finalLineage,
      reason: 'Account WAL differs from recovery coverage', owner: 'account' });

    const missingDeletionKey = `missing-deletion-evidence-${randomUUID()}`;
    const missingDeletionOperator = restoreOperator(current, finalLineage,
      { sealedCoverage: envelope, hmacKey: recoveryKey });
    const held = await missingDeletionOperator.request(missingDeletionKey, envelope);
    await expectHeldRestore({ response: held, key: missingDeletionKey, access: current.access,
      lineage: finalLineage, reason: 'Account deletion recovery evidence is incomplete',
      owner: 'account' });
    await expect(assertGraphAdmissionOpen(fuseki, finalLineage))
      .rejects.toBeInstanceOf(RecoveryHold);
    const restoreKey = `deletion-restore-${randomUUID()}`;
    const operator = restoreOperator(current, finalLineage,
      { sealedCoverage: envelope, hmacKey: recoveryKey });
    const restoreRequest = (sets: string[], key = restoreKey) => operator.request(key, envelope, sets);
    const restoredResponse = await restoreRequest([sealedSet]);
    expect(restoredResponse.status).toBe(201);
    const restoredResult = await restoredResponse.json() as { id: string; state: string;
      disposition: string };
    expect(restoredResult).toMatchObject({ state: 'reconciled', disposition: 'matched' });
    expect((await restoreRequest([sealedSet])).status).toBe(200);
    expect((await current.access.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0])
      .toEqual({ open: true, generation: (BigInt(finalFence) + 1n).toString() });
    await expectNativeRelease(finalLineage, after);
    const releaseBindings = await relay.query<{ owner: string; item_kind: string;
      item_ref: string; disposition: string }>(`SELECT owner, item_kind, item_ref, disposition
        FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1
          AND item_ref LIKE 'restore-release:%'`, [restoredResult.id]);
    expect(releaseBindings.rows).toHaveLength(1);
    expect(releaseBindings.rows[0]).toMatchObject({ owner: 'access', item_kind: 'authority_fence',
      disposition: 'matched' });
    const deletionCut = await relay.query<{ owner: string; status: string }>(
      'SELECT owner, status FROM relay.owner_reconciliation_cut WHERE reconciliation_id = $1',
      [restoredResult.id]);
    expect(deletionCut.rows).toHaveLength(6);
    expect(new Set(deletionCut.rows.map(row => row.owner))).toEqual(new Set([
      'account', 'access', 'content', 'graph', 'object', 'relay']));
    expect(deletionCut.rows.every(row => row.status === 'matched')).toBe(true);
    await expect(assertGraphAdmissionOpen(fuseki, finalLineage)).resolves.toBeUndefined();
    expect(await privateRows(current.account, deleted.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect((await publicGraph()).boolean).toBe(true);
  } finally {
    await app?.stop();
    await Promise.allSettled(pools.map(pool => pool.end()));
    for (const data of replayData) {
      if (spawnSync('pg_ctl', ['-D', data, 'status'], { cwd: state, timeout: 5_000 }).status === 0) {
        execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-t', '10', '-w', 'stop'],
          { cwd: state, timeout: 15_000 });
      }
    }
    try { if (started) await rootCommand(['stack:reset', ...stackArgs], 120_000); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
}, qaStartupTestTimeout(300_000));
