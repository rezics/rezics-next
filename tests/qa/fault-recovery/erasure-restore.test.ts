import { qaStartupTestTimeout, runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { startPostgresCluster, type PostgresCluster }
  from '../support/postgres-cluster.ts';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { installConsentRefreshFence } from '../../../services/account/src/consent-fence.ts';
import { captureDeletionRecoverySet } from '../../../services/account/src/deletion-recovery-set.ts';
import { openRecoveryPayload, sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable, engageAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { publishAdmittedContent } from '../../../services/main/src/modules/content-publication/publish-admitted.ts';
import { applyContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import { accountCredentialsPresent, settleAccountErasures } from '../../../services/main/src/modules/erasure/account.ts';
import { readGraphErasureProof, suppressGraphContentRevisions } from
  '../../../services/main/src/modules/erasure/graph.ts';
import { ensureRetentionDomain, ERASURE_JOURNAL_EPOCH, journalErasure, markErasureSuppressed,
  readErasure, recordErasureInventory, retireRetentionDomain, sha256 }
  from '../../../services/main/src/modules/erasure/journal.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold,
  verifyErasure } from '../../../services/main/src/modules/erasure/reconcile.ts';
import type { RestoredGraphCustody } from '../../../services/main/src/modules/erasure/custody.ts';
import { heldErasureMaintenanceClient } from '../../../services/main/src/modules/erasure/graph.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { mirrorAccountDeletionIntent, mirrorAccountDeletionIntents } from
  '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { retainAccountSubjectDeletion } from '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import { initializeFreshGraph, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { readGraphRecoverySource, readRestoredGraphReleaseExpectation } from
  '../../../services/main/src/modules/work/restore-lineage.ts';
import { ensureModelGeneration } from '../../../services/main/src/modules/semantic/command.ts';
import { relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody } from
  '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';
import { constructRetainedErasureCandidatesInOrder, createRetainedErasureRecoveryFixture, DirectoryObjects,
  type RetainedErasureNativeSnapshot } from './retained-erasure-recovery-fixture.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'c5'.repeat(32);

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

test('OPS11/OPS12/IAM11/SEARCH20: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `owner-cut-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent'];
  const state = join(root, '.temp', `erasure-restore-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const pools: Pool[] = [];
  const replayClusters: PostgresCluster[] = [];
  let app: ReturnType<typeof createAccountApp> | undefined;
  let recoveryFixture: ReturnType<typeof createRetainedErasureRecoveryFixture> | undefined;
  let started = false;
  try {
    started = true;
    await rootCommand(['stack:up', ...stackArgs], 180_000);
    const stack = stackDirectory(root, { profile: 'qa', runId, persistent: true });
    const apps = readEnv(join(stack, 'apps.env'));
    const compose = readEnv(join(stack, 'compose.env'));
    const account = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
    const access = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    const relay = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    const accountOwner = new Pool({ connectionString:
      `postgresql://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}`
        + `@127.0.0.1:${compose.POSTGRES_PORT}/account` });
    pools.push(account, access, contentPool, relay, accountOwner);
    await migrate(access, 'access');
    await migrate(relay, 'relay');
    await migrateContent(contentPool);

    // Real Account owner whose deletion hook fences Access and journals the tombstone.
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const issuer = `${baseURL}/api/auth`;
    const registry = new AccessAdmissionRegistry(access);
    const operators = new Set<string>();
    const config = { baseURL, secret: apps.ACCOUNT_SECRET!, resource: apps.ACCOUNT_MAIN_RESOURCE!,
      pool: account, operatorUserIds: operators,
      accessDeletionFence: async (subject: string) => {
        const fence = await registry.strongDeactivateAccountSubject(issuer, subject);
        if (fence) await mirrorAccountDeletionIntent(access, relay, fence.principalId, fence.enforcementEpoch);
        await retainAccountSubjectDeletion(relay, issuer, subject);
      } };
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    await installConsentRefreshFence(account);
    const auth = createAccountAuth(config);
    app = createAccountApp(auth, account).listen({ hostname: '127.0.0.1', port });
    const signUp = async (name: string) => {
      const email = `${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${baseURL}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }) });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        cookie: response.headers.get('set-cookie')!, password };
    };
    const erased = await signUp('erased');
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: baseURL });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Erasure restore verifier', scope: 'access:manage',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['access:manage'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const browserClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Erasure restore browser', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid access:manage work:create work:edit',
        skip_consent: true, require_pkce: true } });
    const token = (await signIn({
      account: baseURL, clientId: browserClient.client_id, redirectUri,
      scope: 'openid access:manage work:create work:edit', resource: apps.ACCOUNT_MAIN_RESOURCE!,
    }, operator.cookie)).accessToken;
    const verifier = new AccountAssertionVerifier({ issuer, audience: apps.ACCOUNT_MAIN_RESOURCE!,
      jwksUrl: `${baseURL}/api/auth/jwks`, introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });

    // Access: the erased member's principal and the operator's erasure authority on one Work.
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const [erasedPrincipal, operatorPrincipal] = [randomUUID(), randomUUID()];
    await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $3, $4), ($2, $3, $5)`, [erasedPrincipal, operatorPrincipal, issuer, erased.id, operator.id]);
    await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    const laterAuthorityScope = `authority:restore:${randomUUID()}`;
    await access.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [laterAuthorityScope]);

    // Retained frontier: signed coverage head plus the erasure journal epoch it covered.
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    let lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    await initializeFreshGraph(fuseki, lineage);
    const objects = new DirectoryObjects(join(state, 'objects'));
    const workEnvironment: WorkActivationEnvironment = { fuseki, lineage,
      objectDirectory: objects.directory, workObjects: objects };
    await ensureModelGeneration(workEnvironment);
    const request = new Request('http://main.local/v1/works', {
      headers: { authorization: `Bearer ${token}` } });
    const grant = async (scope: string, action: string) => {
      await access.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await access.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), operatorPrincipal, actor, action]);
      await access.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), actor, scope, action]);
    };
    await grant('work:create:root', 'work.create');
    const createdWork = await createAdmittedMetadataWork(workEnvironment, verifier, registry, request, {
      title: 'Retained erasure recovery Work', language: 'en', actingSubject: actor,
      idempotencyKey: `erasure-restore-work-${randomUUID()}` });
    const work = createdWork.work;
    expect((await access.query<{ state: string; graph_outcome: string; graph_receipt: string;
      graph_data_epoch: string; graph_sequence: string }>(`SELECT state, graph_outcome, graph_receipt,
      graph_data_epoch, graph_sequence FROM access.admission WHERE id = $1`,
    [createdWork.admissionId])).rows[0]).toEqual({ state: 'sealed', graph_outcome: 'succeeded',
      graph_receipt: createdWork.receipt, graph_data_epoch: createdWork.dataEpoch,
      graph_sequence: createdWork.sequence });
    await access.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`erasure:${work}`]);
    await access.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'erasure.request', now() + interval '1 hour')`, [randomUUID(), operatorPrincipal, actor]);
    await access.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'erasure.request', now() + interval '1 hour')`,
    [randomUUID(), actor, `erasure:${work}`]);

    // Content targets include one API-erased payload, one published later target,
    // one target for the stale-journal case and unrelated public text.
    const content = new ContentCore(contentPool);
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const variant = { id: variantId, resourceId: work,
      language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
    const staleVariant = { ...variant, id: `urn:rezics:variant:${randomUUID()}` };
    const heads = new Map<string, string | null>();
    const save = async (body: string, targetVariant = variant) => {
      const expectedHead = heads.get(targetVariant.id) ?? null;
      const saved = await content.saveDraft({ operationId: `erasure-restore-${randomUUID()}`, variant: targetVariant,
        expectedHead, model: 'content-shape-v1', sourceRevision: null,
        provenance: { fixture: 'erasure-restore' }, serializedJson: JSON.stringify({ body }) });
      if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('Content save failed');
      heads.set(targetVariant.id, saved.revisionId);
      return { revisionId: saved.revisionId, position: saved.position };
    };
    const payloadBody = 'private payload that must not come back';
    const payloadSaved = await save(payloadBody);
    const unrelatedSaved = await save('unrelated public text');
    const laterSaved = await save('later erasure target');
    const staleTargetSaved = await save('stale-journal erasure target', staleVariant);
    const { revisionId: payload } = payloadSaved;
    const { revisionId: unrelated } = unrelatedSaved;
    const { revisionId: later } = laterSaved;
    const { revisionId: staleTarget } = staleTargetSaved;
    recoveryFixture = createRetainedErasureRecoveryFixture({
      runId, state, source: { account, access, content: contentPool, relay }, accountOwner, fuseki,
      recoveryKey, objects,
      quiesceAccount: async () => { await app?.stop(); app = undefined; },
      resumeAccount: async () => {
        if (!app) app = createAccountApp(auth, account).listen({ hostname: '127.0.0.1', port });
      },
    });
    const captureAndBackup = async (name: string, reuseNativeSnapshot?: RetainedErasureNativeSnapshot) => {
      const captured = await recoveryFixture!.captureAndRestore(name, {
        ...(name === 'before' ? {} : { captureDeletionSet: async () => JSON.stringify(sealRecoveryPayload(
          await captureDeletionRecoverySet(accountOwner, access, issuer, erased.id),
          recoveryKey, 'deletion-recovery-set')) }),
        ...(reuseNativeSnapshot ? { reuseNativeSnapshot } : {}),
      });
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60_000);
      for (const owner of ['account', 'content'] as const) {
        await ensureRetentionDomain(relay, { label: `${owner}:backup:${name}:${runId}`, owner,
          store: 'postgresql', custody: 'backup', expiresAt });
      }
      return { ...captured, expiresAt };
    };
    const credentials = async (pool: Pool, subject: string) => (await pool.query<{ users: string;
      passwords: string; sessions: string }>(`SELECT (SELECT count(*) FROM "user" WHERE id = $1)::text AS users,
      (SELECT count(*) FROM "account" WHERE "userId" = $1)::text AS passwords,
      (SELECT count(*) FROM "session" WHERE "userId" = $1)::text AS sessions`, [subject])).rows[0];
    const exact = async (pool: Pool, id: string) =>
      (await new ContentCore(pool).readExactBatch([id], async ids => new Set(ids)))[0];
    const drainMainRelay = async (consumer: string) => {
      for (let batch = 0; batch < 32; batch++) {
        if (!await relayMainOutboxOnce(fuseki, relay, consumer)) return;
      }
      throw new Error('erasure restore Main relay drain exceeded its bound');
    };
    const readSourceAfterDrain = async (consumer: string) => {
      const expected = await readGraphRecoverySource(fuseki);
      await drainMainRelay(consumer);
      const sourceCut = await readGraphRecoverySource(fuseki);
      expect(sourceCut).toEqual(expected);
      const checkpoint = (await relay.query<{ stream_scope: string; data_epoch: string; sequence: string }>(
        `SELECT stream_scope, data_epoch, sequence::text FROM relay.checkpoint WHERE consumer = $1`,
        [consumer])).rows[0];
      expect(checkpoint).toEqual({ stream_scope: sourceCut.relay.streamScope,
        data_epoch: sourceCut.relay.dataEpoch, sequence: sourceCut.relay.sequence });
      return sourceCut;
    };

    // Backup 1 predates Account and Content erasure, with the admitted Work and drafts present.
    const first = await captureAndBackup('before');
    expect(first.sourceCut).toEqual(await readGraphRecoverySource(fuseki));

    const bindCandidate = async (cut: typeof first) => {
      const candidate = await cut.restore();
      const { restored, candidateGraph, candidateObjects } = candidate;
      const accessFence = (await restored.access.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
      expect(accessFence).toEqual({ open: false, generation: cut.restoredFence });
      const graphRelease = await readRestoredGraphReleaseExpectation(
        candidateGraph.fuseki, candidateGraph.lineage, cut.coverage);
      expect(graphRelease.saved).toEqual({ dataEpoch: cut.sourceCut.dataEpoch,
        graphSequence: cut.sourceCut.sequence, main: { streamScope: cut.coverage.relay.streamScope,
          dataEpoch: cut.sourceCut.relay.dataEpoch, sequence: cut.sourceCut.relay.sequence } });
      expect(graphRelease.effective).toEqual(graphRelease.saved);
      const receiptCustody = new ReceiptCustody(new PostgresReceiptCustodyStore(restored.access),
        candidateObjects, candidateGraph.fuseki, compose.FUSEKI_TITLE_ADMISSION_KEY!,
        proofRetirementSender(candidateGraph.url, compose.FUSEKI_COMMAND_TOKEN!));
      const graph: RestoredGraphCustody = {
        fuseki: candidateGraph.fuseki,
        lineage: candidateGraph.lineage,
        receiptCustody,
        heldErasure: {
          cut: { ...candidateGraph.lineage, restoreCutover: graphRelease.restoreCutover,
            priorDataEpoch: graphRelease.saved.dataEpoch, priorSequence: graphRelease.saved.graphSequence },
          accessHoldGeneration: accessFence!.generation,
          signingKey: compose.FUSEKI_TITLE_ADMISSION_KEY!,
          maintenance: heldErasureMaintenanceClient(candidateGraph.url, compose.FUSEKI_MAINTENANCE_TOKEN!),
          originalSource: 'retained-native-event',
        },
      };
      return { ...candidate, restored: { ...restored, graph,
        objects: { directory: candidateObjects.directory, workObjects: candidateObjects } }, receiptCustody };
    };
    const readFindings = async (reconciliationId: string) => (await relay.query<{
      owner: string; item_kind: string; item_ref: string; disposition: string; evidence_digest: string;
    }>(`SELECT owner, item_kind, item_ref, disposition, evidence_digest
      FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1
      ORDER BY ordinal`, [reconciliationId])).rows;
    const expectFinding = (findings: Awaited<ReturnType<typeof readFindings>>, expected: {
      owner: string; item_kind: string; item_ref: string; disposition: string;
    }) => expect(findings).toContainEqual(expect.objectContaining(expected));
    const expectFindingPrefix = (findings: Awaited<ReturnType<typeof readFindings>>, expected: {
      owner: string; item_kind: string; item_refPrefix: string; disposition: string;
    }) => expect(findings.some(finding => finding.owner === expected.owner
      && finding.item_kind === expected.item_kind && finding.item_ref.startsWith(expected.item_refPrefix)
      && finding.disposition === expected.disposition)).toBe(true);
    const expectCustodyFindings = (findings: Awaited<ReturnType<typeof readFindings>>) => {
      expectFinding(findings, { owner: 'object', item_kind: 'payload',
        item_ref: 'retained-command-model-custody', disposition: 'matched' });
      expectFindingPrefix(findings, { owner: 'object', item_kind: 'receipt',
        item_refPrefix: 'retained-custody-roots:', disposition: 'matched' });
      expectFindingPrefix(findings, { owner: 'graph', item_kind: 'authority_fence',
        item_refPrefix: 'restored-graph-binding:', disposition: 'matched' });
      expectFindingPrefix(findings, { owner: 'relay', item_kind: 'receipt',
        item_refPrefix: 'restore-reconciliation:', disposition: 'matched' });
    };
    const expectBothHoldsClosed = async (candidate: Awaited<ReturnType<typeof bindCandidate>>) => {
      const { restored } = candidate;
      expect((await restored.access.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0])
        .toEqual({ open: false, generation: candidate.restoredFence });
      expect((await restored.graph!.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
        GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product>
          rv:dataEpoch "${restored.graph!.lineage.dataEpoch}" ;
          rv:routingEpoch "${restored.graph!.lineage.routingEpoch}" ; rv:sequence 0 ; rv:restoreHold true . } }`)).boolean)
        .toBe(true);
    };

    // IAM11: Account erasure through the Account owner, then journal settlement.
    const deletion = await fetch(`${baseURL}/api/auth/delete-user`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: erased.cookie, origin: baseURL },
      body: JSON.stringify({ password: erased.password }) });
    expect(deletion.status).toBe(200);
    expect(await credentials(account, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await credentials(account, operator.id)).toMatchObject({ users: '1' });
    await mirrorAccountDeletionIntents(access, relay);
    expect(await settleAccountErasures(relay, access, account)).toBe(1);
    const accountErasureId = (await relay.query<{ id: string }>(
      'SELECT id FROM relay.erasure WHERE account_issuer = $1 AND account_subject = $2',
      [issuer, erased.id])).rows[0]!.id;

    // Backup 2 follows Account erasure and still predates scope closure and Content erasure.
    const second = await captureAndBackup('after-account', first.nativeSnapshot);
    expect(Number(second.coveredEpoch)).toBeGreaterThan(Number(first.coveredEpoch ?? '0'));
    expect(second.sourceCut).toEqual(first.sourceCut);
    expect(second.nativeSnapshot).toBe(first.nativeSnapshot);
    expect(second.backup).not.toBe(first.backup);
    expect(second.backupObjects).not.toBe(first.backupObjects);
    expect(second.authority.sealedCoverage).not.toBe(first.authority.sealedCoverage);

    // Save the exact original owner bytes before the real Main erasure for the later corruption probe.
    const originalPayload = (await contentPool.query<{ serialized_bytes: Buffer; body: object }>(
      'SELECT serialized_bytes, body FROM content.revision WHERE id = $1', [payload])).rows[0]!;
    expect((await exact(contentPool, payload)).serializedJson)
      .toBe(JSON.stringify({ body: payloadBody }));

    // OPS12: this Access closure is absent from backup 2. Main then admits the
    // initial Content erasure before the final authority capture.
    expect(await registry.closeScope(laterAuthorityScope, '0')).toMatchObject({ authorityEpoch: '1' });
    const main = createMainApp(fuseki, { environment: { ...workEnvironment, fuseki, lineage,
      objectDirectory: objects.directory, workObjects: objects },
      account: verifier, access: registry, erasures: new ErasureService(relay, contentPool, access) });
    const erase = async (revisionIds: string[]) => {
      const response = await main.handle(new Request('http://main.local/v1/erasures', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': `erasure-restore-${randomUUID()}` },
        body: JSON.stringify({ profile: 'content-revision-erasure-v1', actingSubject: actor,
          resourceId: work, revisionIds }) }));
      expect(response.status).toBe(200);
      return await response.json() as { erasureId: string; erasureEpoch: string };
    };
    const contentErasure = await erase([payload]);
    expect(await exact(contentPool, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(contentPool, unrelated)).toMatchObject({ status: 'available' });
    expect(await verifyErasure(relay, { content: contentPool }, contentErasure.erasureId,
      `verify:${contentErasure.erasureId}`)).toMatchObject({ state: 'reconciled' });
    const apiErasureReport = await readErasure(relay, contentErasure.erasureId);
    expect(apiErasureReport).toMatchObject({ erasureId: contentErasure.erasureId,
      erasureEpoch: contentErasure.erasureEpoch, stage: 'verified', suppression: 'suppressed' });
    const apiErasureAdmission = (await access.query<{ state: string; graph_outcome: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string }>(
      `SELECT state, graph_outcome, graph_receipt, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [apiErasureReport.admissionId])).rows[0];
    expect(apiErasureAdmission).toMatchObject({ state: 'sealed', graph_outcome: 'succeeded',
      graph_data_epoch: ERASURE_JOURNAL_EPOCH, graph_sequence: contentErasure.erasureEpoch });
    expect(apiErasureAdmission?.graph_receipt).toMatch(/^urn:rezics:receipt:/);
    const apiErasureCut = await readSourceAfterDrain(second.consumer);
    expect(BigInt(apiErasureCut.sequence)).toBeGreaterThan(BigInt(second.sourceCut.sequence));

    // A historical active pin is admitted on a different exact target. The fourth
    // exact revision remains available for the later stale-journal injection.
    const laterExact = (await content.readExactBatch([later], async ids => new Set(ids)))[0];
    if (laterExact?.status !== 'available') throw new Error('later Content revision is unavailable');
    const laterPreparation = `erasure-restore-active-${randomUUID()}`;
    await grant(`work:read:${work}`, 'work.read');
    await grant(`content:publish:${work}`, 'content.publish');
    const laterPublication = await publishAdmittedContent(workEnvironment, content,
      verifier, registry, request, {
        preparationId: laterPreparation, revisionId: later,
        expectedDigest: laterExact.reference.byteDigest,
        expectedContentEpoch: laterSaved.position.dataEpoch,
        resourceId: work, variantId, expectedPublicationHead: null,
        actingSubject: actor, idempotencyKey: `erasure-restore-publish-${randomUUID()}` });
    if (laterPublication.status !== 'active' || !laterPublication.decision
      || !laterPublication.graphDataEpoch || !laterPublication.graphSequence) {
      throw new Error('admitted historical Content publication did not activate');
    }
    const laterNativeReceipt = laterPublication.receipt;
    const laterNativeSequence = laterPublication.graphSequence;
    const pin = (await contentPool.query<{ status: string; pin_active: boolean; graph_receipt: string;
      graph_data_epoch: string; graph_sequence: string }>(`SELECT status, pin_active, graph_receipt,
      graph_data_epoch, graph_sequence FROM content.publication_preparation WHERE operation_id = $1`,
    [laterPreparation])).rows[0];
    expect(pin).toEqual({ status: 'active', pin_active: true, graph_receipt: laterNativeReceipt,
      graph_data_epoch: laterPublication.graphDataEpoch, graph_sequence: laterNativeSequence });
    const publicationAdmission = (await access.query<{ id: string; state: string; graph_outcome: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string }>(`SELECT id, state,
      graph_outcome, graph_receipt, graph_data_epoch, graph_sequence FROM access.admission
      WHERE graph_receipt = $1`, [laterNativeReceipt])).rows[0];
    expect(publicationAdmission).toMatchObject({ state: 'sealed', graph_outcome: 'succeeded',
      graph_receipt: laterNativeReceipt, graph_data_epoch: laterPublication.graphDataEpoch,
      graph_sequence: laterNativeSequence });
    expect((await exact(contentPool, staleTarget)).status).toBe('available');
    const finalSourceCut = await readSourceAfterDrain(second.consumer);
    expect(BigInt(finalSourceCut.sequence)).toBeGreaterThan(BigInt(apiErasureCut.sequence));
    const third = await captureAndBackup('after-authority');
    expect(third.sourceCut).toEqual(finalSourceCut);
    expect(third.nativeSnapshot).not.toBe(first.nativeSnapshot);
    expect(third.sourceCut).toMatchObject({ dataEpoch: lineage.dataEpoch,
      relay: { dataEpoch: lineage.dataEpoch } });

    // The recovery fault injections use the established owner chain only after
    // the final signed authority cut. No Access admission may be added afterward.
    await app?.stop();
    app = undefined;
    const sourceRecoveryGeneration = await engageAccessRecoveryFence(access);
    const fence = (await access.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
    expect(fence).toEqual({ open: false, generation: sourceRecoveryGeneration });
    const admissionsAtFence = (await access.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM access.admission')).rows[0]!.count;
    const ownerErasure = async (revisionId: string, label: string) => {
      const entry = await journalErasure(relay, {
        operationId: `erasure-restore-owner-${label}-${randomUUID()}`,
        requestDigest: sha256(JSON.stringify({ family: 'erasure-restore-owner-v1', label, revisionId })),
        kind: 'revision', principalId: operatorPrincipal, admissionId: randomUUID(),
        authorityEpoch: sourceRecoveryGeneration,
        targets: [{ kind: 'content_revision', ref: revisionId }],
      });
      expect(entry.replayed).toBe(false);
      await suppressGraphContentRevisions(fuseki, lineage,
        entry.erasureId, entry.erasureEpoch, [revisionId]);
      const nativeProof = await readGraphErasureProof(fuseki, lineage,
        entry.erasureId, entry.erasureEpoch, [revisionId]);
      expect(nativeProof.dataEpoch).toBe(third.sourceCut.dataEpoch);
      expect(BigInt(nativeProof.sequence)).toBeGreaterThan(BigInt(third.sourceCut.sequence));
      await applyContentErasure(contentPool, { erasureId: entry.erasureId,
        erasureEpoch: entry.erasureEpoch, resourceId: work, revisionIds: [revisionId],
        graphProof: nativeProof, preservationAccess: access });
      await markErasureSuppressed(relay, entry.erasureId);
      await recordErasureInventory(relay, entry.erasureId, { owners: ['content'],
        liveRetentionReason: 'Source Content rows and WAL remain until qualified recovery.' });
      const sourceAfterDrain = await readSourceAfterDrain(third.consumer);
      expect(sourceAfterDrain.dataEpoch).toBe(third.sourceCut.dataEpoch);
      expect(sourceAfterDrain.routingEpoch).toBe(third.sourceCut.routingEpoch);
      expect(BigInt(sourceAfterDrain.relay.sequence)).toBeGreaterThan(BigInt(third.sourceCut.relay.sequence));
      expect(await exact(contentPool, revisionId)).toMatchObject({ status: 'erased' });
      const retainedEvent = (await relay.query<{ erasure_epoch: string; native_data_epoch: string;
        native_sequence: string; receipt: string; relay_scope: string; relay_data_epoch: string;
        relay_sequence: string }>(`SELECT
          envelope->'data'->'receipt'->'systemProof'->>'erasureEpoch' AS erasure_epoch,
          envelope->'data'->'sourcePosition'->>'dataEpoch' AS native_data_epoch,
          envelope->'data'->'sourcePosition'->>'sequence' AS native_sequence,
          envelope->'data'->'receipt'->>'id' AS receipt,
          envelope->'data'->'relayPosition'->>'streamScope' AS relay_scope,
          envelope->'data'->'relayPosition'->>'dataEpoch' AS relay_data_epoch,
          envelope->'data'->'relayPosition'->>'sequence' AS relay_sequence
        FROM relay.delivered_event
        WHERE envelope->'data'->'receipt'->'systemProof'->>'erasureId' = $1`,
      [entry.erasureId])).rows;
      expect(retainedEvent).toHaveLength(1);
      const event = retainedEvent[0]!;
      expect(event).toEqual({ erasure_epoch: entry.erasureEpoch,
        native_data_epoch: nativeProof.dataEpoch, native_sequence: nativeProof.sequence,
        receipt: nativeProof.receipt, relay_scope: MAIN_RELAY_STREAM_SCOPE,
        relay_data_epoch: third.sourceCut.relay.dataEpoch,
        relay_sequence: sourceAfterDrain.relay.sequence });
      expect(entry.erasureEpoch).not.toBe(nativeProof.sequence);
      expect(entry.erasureEpoch).not.toBe(event.relay_sequence);
      expect({ datasetId: 'product', dataEpoch: event.native_data_epoch,
        sequence: event.native_sequence }).not.toEqual({ streamScope: event.relay_scope,
        dataEpoch: event.relay_data_epoch, sequence: event.relay_sequence });
      const report = await readErasure(relay, entry.erasureId);
      expect(report).toMatchObject({ erasureEpoch: entry.erasureEpoch, stage: 'inventory_complete',
        suppression: 'suppressed', destruction: 'retained',
        targets: [{ kind: 'content_revision', ref: revisionId }] });
      expect((await access.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM access.admission')).rows[0]!.count).toBe(admissionsAtFence);
      return { ...entry, nativeProof, retainedEvent: event };
    };
    const pinnedErasure = await ownerErasure(later, 'pinned-target');

    // OPS11: preserve the real Main erasure proof and all three retained backup domains.
    expect(await verifyErasure(relay, { account, access }, accountErasureId, `verify:${accountErasureId}`))
      .toMatchObject({ state: 'reconciled' });
    expect(await verifyErasure(relay, { content: contentPool }, contentErasure.erasureId,
      `verify:${contentErasure.erasureId}`)).toMatchObject({ state: 'reconciled' });
    for (const [erasureId, owner] of [[accountErasureId, 'account'], [contentErasure.erasureId, 'content']] as const) {
      const report = await readErasure(relay, erasureId);
      expect(report).toMatchObject({ stage: 'verified', suppression: 'suppressed', destruction: 'retained' });
      const copies = new Map(report.dispositions.map(entry => [entry.domain, entry]));
      expect(copies.get(`${owner}:postgresql:live`)).toMatchObject({ suppression: 'suppressed', destruction: 'retained' });
      expect(copies.get(`${owner}:postgresql-wal:live`)).toMatchObject({ store: 'postgresql_wal',
        suppression: 'suppressed', destruction: 'retained' });
      expect(copies.get(`${owner}:backup:before:${runId}`)).toMatchObject({ suppression: 'not_applicable',
        destruction: 'retained', retainedUntil: first.expiresAt.toISOString() });
      expect(copies.get(`${owner}:backup:after-account:${runId}`)).toMatchObject({ suppression: 'not_applicable',
        destruction: 'retained', retainedUntil: second.expiresAt.toISOString() });
      expect(copies.get(`${owner}:backup:after-authority:${runId}`)).toMatchObject({ suppression: 'not_applicable',
        destruction: 'retained', retainedUntil: third.expiresAt.toISOString() });
    }
    const [firstCandidate, secondCandidate, thirdCandidate] = await constructRetainedErasureCandidatesInOrder(
      [first, second, third], bindCandidate);
    const secondRestored = secondCandidate.restored;
    const thirdRestored = thirdCandidate.restored;
    expect((await secondRestored.access.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1', [laterAuthorityScope])).rows[0]?.open).toBe(true);
    const staleAuthority = await reconcileRestoredErasures(relay, secondRestored, {
      operationId: `restore-stale-authority-${runId}`, consumer: second.consumer,
      replay: true, authority: second.authority,
    });
    expect(staleAuthority).toMatchObject({ state: 'held' });
    const staleAuthorityFindings = await readFindings(staleAuthority.reconciliationId);
    expectCustodyFindings(staleAuthorityFindings);
    expectFinding(staleAuthorityFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'conflict' });
    expectFinding(staleAuthorityFindings, { owner: 'content', item_kind: 'revision',
      item_ref: payload, disposition: 'conflict' });
    expect(await exact(secondRestored.content, payload)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: payloadBody }) });
    expect((await secondRestored.content.query<{ availability: string; serialized_bytes: Buffer; body: object }>(
      'SELECT availability, serialized_bytes, body FROM content.revision WHERE id = $1', [payload])).rows[0])
      .toEqual({ availability: 'available', serialized_bytes: originalPayload.serialized_bytes,
        body: originalPayload.body });
    expect(await credentials(secondRestored.account, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    await expectBothHoldsClosed(secondCandidate);
    await expect(releaseErasureRestoreHold(relay, secondRestored, staleAuthority.reconciliationId,
      second.restoredFence, second.authority)).rejects.toBeInstanceOf(ErasureRestoreHold);
    await expectBothHoldsClosed(secondCandidate);
    expect((await thirdRestored.access.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1', [laterAuthorityScope])).rows[0]?.open).toBe(false);

    // The live Account owner keeps verifying the operator while restored copies stay isolated.
    const offline = (candidate: Awaited<ReturnType<typeof bindCandidate>>) => createMainApp(
      candidate.candidateGraph.fuseki, { environment: { fuseki: candidate.candidateGraph.fuseki,
        lineage: candidate.candidateGraph.lineage, objectDirectory: candidate.candidateObjects.directory,
        workObjects: candidate.candidateObjects, receiptCustody: candidate.receiptCustody }, account: verifier,
      access: new AccessAdmissionRegistry(candidate.restored.access),
      erasures: new ErasureService(relay, candidate.restored.content, candidate.restored.access) });
    const readJournal = (mainApp: ReturnType<typeof offline>) => mainApp.handle(new Request(
      `http://main.local/v1/erasures/${contentErasure.erasureId}`, { headers: { authorization: `Bearer ${token}` } }));

    // Backup 1 still holds the erased payload and the erased member's credentials.
    const older = firstCandidate.restored;
    expect(await exact(older.content, payload)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: payloadBody }) });
    expect(await credentials(older.account, erased.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    expect(await accountCredentialsPresent(older.account, [erased.id])).toEqual(new Set([erased.id]));
    // OPS12: protected reads and new effects stay offline on the fenced restore.
    const olderMain = offline(firstCandidate);
    expect((await readJournal(olderMain)).status).toBe(503);
    await expect(new AccessAdmissionRegistry(older.access).canReadWork({ issuer, subject: operator.id }, actor, work))
      .rejects.toBeInstanceOf(AdmissionUnavailable);
    await expect(releaseErasureRestoreHold(relay, older, randomUUID(), first.restoredFence, first.authority))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    const olderPass = await reconcileRestoredErasures(relay, older,
      { operationId: `restore-before-${runId}`, consumer: first.consumer, replay: true,
        authority: first.authority });
    expect(olderPass).toMatchObject({ state: 'held' });
    const olderFindings = await readFindings(olderPass.reconciliationId);
    expectCustodyFindings(olderFindings);
    expectFinding(olderFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'conflict' });
    expectFinding(olderFindings, { owner: 'account', item_kind: 'erasure',
      item_ref: `account-subject:${sha256(erased.id)}`, disposition: 'conflict' });
    expect(await exact(older.content, payload)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: payloadBody }) });
    expect((await older.content.query<{ availability: string; serialized_bytes: Buffer; body: object }>(
      'SELECT availability, serialized_bytes, body FROM content.revision WHERE id = $1', [payload])).rows[0])
      .toEqual({ availability: 'available', serialized_bytes: originalPayload.serialized_bytes,
        body: originalPayload.body });
    expect(await credentials(older.account, erased.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    await expect(releaseErasureRestoreHold(relay, older, olderPass.reconciliationId,
      first.restoredFence, first.authority))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    await expectBothHoldsClosed(firstCandidate);
    expect((await readJournal(olderMain)).status).toBe(503);
    expect(await credentials(older.account, erased.id)).toMatchObject({ users: '1' });

    // The final backup includes the API erasure and current Access authority;
    // the retained owner chain has since erased the pinned later target.
    const currentCandidate = thirdCandidate;
    const current = currentCandidate.restored;
    expect(await credentials(current.account, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await accountCredentialsPresent(current.account, [erased.id])).toEqual(new Set());
    expect(await exact(current.content, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(current.content, later)).toMatchObject({ status: 'available' });
    expect(await exact(current.content, staleTarget)).toMatchObject({ status: 'available' });
    expect((await current.content.query<{ pin_active: boolean; status: string }>(
      'SELECT pin_active, status FROM content.publication_preparation WHERE operation_id = $1',
      [laterPreparation])).rows[0]).toEqual({ pin_active: true, status: 'active' });
    const currentMain = offline(currentCandidate);
    const unreplayed = await reconcileRestoredErasures(relay, current,
      { operationId: `restore-hold-${runId}`, consumer: third.consumer, replay: false,
        authority: third.authority });
    expect(unreplayed).toMatchObject({ state: 'held' });
    const unreplayedFindings = await readFindings(unreplayed.reconciliationId);
    expectCustodyFindings(unreplayedFindings);
    expectFinding(unreplayedFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'matched' });
    expectFinding(unreplayedFindings, { owner: 'content', item_kind: 'revision',
      item_ref: later, disposition: 'conflict' });
    expectFinding(unreplayedFindings, { owner: 'content', item_kind: 'retention_pin',
      item_ref: `publication:${pinnedErasure.erasureId}`, disposition: 'conflict' });
    await expect(releaseErasureRestoreHold(relay, current, unreplayed.reconciliationId,
      third.restoredFence, third.authority))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    await expectBothHoldsClosed(currentCandidate);
    expect((await readJournal(currentMain)).status).toBe(503);
    const replayed = await reconcileRestoredErasures(relay, current,
      { operationId: `restore-replay-${runId}`, consumer: third.consumer, replay: true,
        authority: third.authority });
    expect(replayed).toMatchObject({ state: 'reconciled' });
    const replayedFindings = await readFindings(replayed.reconciliationId);
    expectCustodyFindings(replayedFindings);
    expectFinding(replayedFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'matched' });
    expectFinding(replayedFindings, { owner: 'graph', item_kind: 'erasure',
      item_ref: pinnedErasure.erasureId, disposition: 'replayed' });
    expectFindingPrefix(replayedFindings, { owner: 'graph', item_kind: 'receipt',
      item_refPrefix: `original-erasure:${pinnedErasure.erasureId}:`, disposition: 'matched' });
    expectFinding(replayedFindings, { owner: 'content', item_kind: 'revision',
      item_ref: later, disposition: 'replayed' });
    expect(pinnedErasure.retainedEvent).toMatchObject({
      erasure_epoch: pinnedErasure.erasureEpoch,
      native_data_epoch: pinnedErasure.nativeProof.dataEpoch,
      native_sequence: pinnedErasure.nativeProof.sequence,
      receipt: pinnedErasure.nativeProof.receipt,
      relay_scope: MAIN_RELAY_STREAM_SCOPE,
    });
    expect((await current.content.query<{ erasure_id: string; erasure_epoch: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string }>(`SELECT
        erasure_id::text AS erasure_id, erasure_epoch::text AS erasure_epoch,
        graph_receipt, graph_data_epoch, graph_sequence::text AS graph_sequence
      FROM content.publication_erasure_supersession WHERE operation_id = $1`,
    [laterPreparation])).rows).toEqual([{ erasure_id: pinnedErasure.erasureId,
      erasure_epoch: pinnedErasure.erasureEpoch, graph_receipt: pinnedErasure.nativeProof.receipt,
      graph_data_epoch: pinnedErasure.nativeProof.dataEpoch,
      graph_sequence: pinnedErasure.nativeProof.sequence }]);
    expect(await exact(current.content, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(current.content, later)).toMatchObject({ status: 'erased' });

    // A second retained owner erasure is introduced only after the first replay
    // qualification, making that qualification stale before release.
    const staleErasure = await ownerErasure(staleTarget, 'stale-target');
    await expect(releaseErasureRestoreHold(relay, current, replayed.reconciliationId,
      third.restoredFence, third.authority))
      .rejects.toMatchObject({ message: 'a newer retained frontier needs reconciliation' });
    await expectBothHoldsClosed(currentCandidate);
    expect((await readJournal(currentMain)).status).toBe(503);
    const final = await reconcileRestoredErasures(relay, current,
      { operationId: `restore-final-${runId}`, consumer: third.consumer, replay: true,
        authority: third.authority });
    expect(final).toMatchObject({ state: 'reconciled', erasureEpoch: staleErasure.erasureEpoch });
    expect(final.reconciliationId).not.toBe(replayed.reconciliationId);
    const finalFindings = await readFindings(final.reconciliationId);
    expectCustodyFindings(finalFindings);
    expectFinding(finalFindings, { owner: 'access', item_kind: 'authority_fence',
      item_ref: 'current-retained-authority-coverage', disposition: 'matched' });
    expectFinding(finalFindings, { owner: 'graph', item_kind: 'erasure',
      item_ref: staleErasure.erasureId, disposition: 'replayed' });
    expectFindingPrefix(finalFindings, { owner: 'graph', item_kind: 'receipt',
      item_refPrefix: `original-erasure:${staleErasure.erasureId}:`, disposition: 'matched' });
    expectFinding(finalFindings, { owner: 'content', item_kind: 'revision',
      item_ref: staleTarget, disposition: 'replayed' });
    expect((await current.content.query<{ erasure_id: string; erasure_epoch: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string }>(`SELECT
        erasure_id::text AS erasure_id, erasure_epoch::text AS erasure_epoch,
        graph_receipt, graph_data_epoch, graph_sequence::text AS graph_sequence
      FROM content.publication_erasure_supersession WHERE operation_id = $1`,
    [laterPreparation])).rows).toEqual([{ erasure_id: pinnedErasure.erasureId,
      erasure_epoch: pinnedErasure.erasureEpoch, graph_receipt: pinnedErasure.nativeProof.receipt,
      graph_data_epoch: pinnedErasure.nativeProof.dataEpoch,
      graph_sequence: pinnedErasure.nativeProof.sequence }]);
    expect((await current.content.query<{ revision_id: string; erasure_id: string;
      erasure_epoch: string }>(`SELECT revision_id::text AS revision_id, erasure_id::text AS erasure_id,
        erasure_epoch::text AS erasure_epoch FROM content.revision_erasure
      WHERE revision_id = ANY($1::uuid[]) ORDER BY revision_id`, [[later, staleTarget]])).rows)
      .toEqual([{ revision_id: later, erasure_id: pinnedErasure.erasureId,
        erasure_epoch: pinnedErasure.erasureEpoch }, { revision_id: staleTarget,
        erasure_id: staleErasure.erasureId, erasure_epoch: staleErasure.erasureEpoch }]
        .sort((left, right) => left.revision_id.localeCompare(right.revision_id)));
    expect(await exact(current.content, staleTarget)).toMatchObject({ status: 'erased' });
    // Simulate an unsafe copy replacement after reconciliation. Release checks
    // the owner again under the retained journal lock, then refuses resurrection.
    const unsafe = await current.content.connect();
    try {
      await unsafe.query('BEGIN');
      await unsafe.query('SET LOCAL session_replication_role = replica');
      await unsafe.query(`UPDATE content.revision SET availability = 'available',
        serialized_bytes = $2, body = $3 WHERE id = $1`,
      [payload, originalPayload.serialized_bytes, originalPayload.body]);
      await unsafe.query('COMMIT');
    } catch (error) {
      await unsafe.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { unsafe.release(); }
    expect(await exact(current.content, payload)).toMatchObject({ status: 'available' });
    await expect(releaseErasureRestoreHold(relay, current, final.reconciliationId,
      third.restoredFence, third.authority)).rejects.toBeInstanceOf(ErasureRestoreHold);
    expect((await readJournal(currentMain)).status).toBe(503);
    await current.content.query(`UPDATE content.revision SET availability = 'erased',
      serialized_bytes = NULL, body = NULL WHERE id = $1`, [payload]);
    const supersessionSequence = (await current.content.query<{ graph_sequence: string }>(
      `SELECT graph_sequence::text FROM content.publication_erasure_supersession
       WHERE operation_id = $1`, [laterPreparation])).rows[0]!.graph_sequence;
    const altered = await current.content.connect();
    try {
      await altered.query('BEGIN');
      await altered.query('SET LOCAL session_replication_role = replica');
      await altered.query(`UPDATE content.publication_erasure_supersession
        SET graph_sequence = graph_sequence + 1 WHERE operation_id = $1`, [laterPreparation]);
      await altered.query('COMMIT');
    } finally { altered.release(); }
    await expect(releaseErasureRestoreHold(relay, current, final.reconciliationId,
      third.restoredFence, third.authority)).rejects.toBeInstanceOf(ErasureRestoreHold);
    const repaired = await current.content.connect();
    try {
      await repaired.query('BEGIN');
      await repaired.query('SET LOCAL session_replication_role = replica');
      await repaired.query(`UPDATE content.publication_erasure_supersession
        SET graph_sequence = $2::bigint WHERE operation_id = $1`,
      [laterPreparation, supersessionSequence]);
      await repaired.query('COMMIT');
    } finally { repaired.release(); }
    const detached = await current.content.connect();
    try {
      await detached.query('BEGIN');
      await detached.query('SET LOCAL session_replication_role = replica');
      await detached.query(`UPDATE content.publication_preparation
        SET status = 'rejected', pin_active = false WHERE operation_id = $1`, [laterPreparation]);
      await detached.query('COMMIT');
    } finally { detached.release(); }
    await expect(releaseErasureRestoreHold(relay, current, final.reconciliationId,
      third.restoredFence, third.authority)).rejects.toBeInstanceOf(ErasureRestoreHold);
    const reattached = await current.content.connect();
    try {
      await reattached.query('BEGIN');
      await reattached.query('SET LOCAL session_replication_role = replica');
      await reattached.query(`UPDATE content.publication_preparation
        SET status = 'active', pin_active = true WHERE operation_id = $1`, [laterPreparation]);
      await reattached.query('COMMIT');
    } finally { reattached.release(); }
    await releaseErasureRestoreHold(relay, current, final.reconciliationId,
      third.restoredFence, third.authority);

    // Reopened restore: no resurrection, credentials absent, unrelated content intact.
    const reopened = await readJournal(currentMain);
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ erasureId: contentErasure.erasureId, stage: 'verified' });
    expect(await exact(current.content, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(current.content, later)).toMatchObject({ status: 'erased' });
    expect(await exact(current.content, unrelated)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: 'unrelated public text' }) });
    expect(await credentials(current.account, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await credentials(current.account, operator.id)).toMatchObject({ users: '1' });
    expect((await readJournal(olderMain)).status).toBe(503);

    // IAM11: build a fresh logical archive only from the reconciled cut. This
    // local, separate cluster represents off-host custody; no pre-erasure
    // physical fileset or WAL is copied into it. The retained relay journal is
    // one of the four owner archives and must survive beside the owner rows.
    const offHost = join(state, 'off-host-custody');
    mkdirSync(offHost, { recursive: true, mode: 0o700 });
    const offHostExpiry = new Date(Date.now() + 14 * 24 * 60 * 60_000);
    for (const owner of ['account', 'access', 'content', 'relay'] as const) {
      await ensureRetentionDomain(relay, { label: `${owner}:off-host:${runId}`,
        owner, store: 'postgresql', custody: 'archive', expiresAt: offHostExpiry });
    }
    const archives = new Map<string, string>();
    const archive = (name: 'account' | 'access' | 'content' | 'relay', port: number) => {
      const file = join(offHost, `${name}.dump`);
      execFileSync('pg_dump', ['-Fc', '-f', file, '-h', '127.0.0.1', '-p', String(port),
        '-U', 'postgres', name], { cwd: state, timeout: 60_000,
        env: { ...process.env, PGPASSWORD: compose.POSTGRES_PASSWORD! } });
      archives.set(name, file);
      return createHash('sha256').update(readFileSync(file)).digest('hex');
    };
    const archiveDigests = [archive('account', current.port),
      archive('access', current.port), archive('content', current.port),
      archive('relay', Number(compose.POSTGRES_PORT))];
    const sealedCustody = JSON.stringify(sealRecoveryPayload({
      format: 'rezics-sanitized-custody-v1',
      erasedSubjects: [erased.id], erasureEpoch: staleErasure.erasureEpoch,
      archives: Object.fromEntries([...archives.keys()].map((name, index) =>
        [name, archiveDigests[index]])),
    }, recoveryKey, 'sanitized-custody'));
    const custodyFile = join(offHost, 'manifest.json');
    writeFileSync(custodyFile, sealedCustody, { mode: 0o600, flag: 'wx' });
    const custody = openRecoveryPayload<{ erasureEpoch: string;
      archives: Record<string, string> }>(readFileSync(custodyFile, 'utf8'),
    recoveryKey, 'sanitized-custody');
    expect(custody.erasureEpoch).toBe(staleErasure.erasureEpoch);
    for (const [name, file] of archives) {
      expect(createHash('sha256').update(readFileSync(file)).digest('hex'))
        .toBe(custody.archives[name]);
    }
    const offHostCluster = await startPostgresCluster({ role: 'postgres' });
    replayClusters.push(offHostCluster);
    const offHostPort = offHostCluster.port;
    const offHostAdmin = new Pool({ host: '127.0.0.1', port: offHostPort,
      database: 'postgres', user: 'postgres' });
    pools.push(offHostAdmin);
    for (const name of ['account', 'access', 'content', 'relay'] as const) {
      await offHostAdmin.query(`CREATE DATABASE ${name}`);
      execFileSync('pg_restore', ['--no-owner', '--no-acl', '-h', '127.0.0.1',
        '-p', String(offHostPort), '-U', 'postgres', '-d', name, archives.get(name)!],
      { cwd: state, timeout: 60_000, stdio: 'pipe' });
    }
    const copy = (database: string) => new Pool({ host: '127.0.0.1', port: offHostPort,
      database, user: 'postgres' });
    const offAccount = copy('account');
    const offAccess = copy('access');
    const offContent = copy('content');
    const offRelay = copy('relay');
    pools.push(offAccount, offAccess, offContent, offRelay);
    expect(await credentials(offAccount, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await credentials(offAccount, operator.id)).toMatchObject({ users: '1' });
    expect(await exact(offContent, payload)).toMatchObject({ status: 'erased' });
    expect(await exact(offContent, later)).toMatchObject({ status: 'erased' });
    expect(await exact(offContent, unrelated)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: 'unrelated public text' }) });
    expect((await offAccess.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1', [laterAuthorityScope])).rows[0]?.open).toBe(false);
    expect(await readErasure(offRelay, contentErasure.erasureId)).toMatchObject({
      erasureEpoch: contentErasure.erasureEpoch, suppression: 'suppressed' });
    expect(await readErasure(offRelay, accountErasureId)).toMatchObject({ suppression: 'suppressed' });

    // Retire the three historical physical backup directories only after the
    // sanitized archive has been restored and probed. The evidence digest
    // identifies this local archive set, not production media destruction.
    const custodyDigest = createHash('sha256').update(JSON.stringify(archiveDigests)).digest('hex');
    for (const copyInfo of [first, second, third]) {
      rmSync(copyInfo.backup, { recursive: true });
      expect(existsSync(copyInfo.backup)).toBe(false);
      for (const owner of ['account', 'content'] as const) {
        await retireRetentionDomain(relay, `${owner}:backup:${copyInfo === first ? 'before'
          : copyInfo === second ? 'after-account' : 'after-authority'}:${runId}`,
        'expired', custodyDigest);
      }
    }
  } finally {
    try {
      await recoveryFixture?.dispose();
    } finally {
      try {
        await app?.stop();
        await Promise.allSettled(pools.map(pool => pool.end()));
        for (const cluster of replayClusters) cluster.remove();
      } finally {
        try { if (started) await rootCommand(['stack:reset', ...stackArgs], 120_000); }
        finally { rmSync(state, { recursive: true, force: true }); }
      }
    }
  }
}, qaStartupTestTimeout(420_000));
