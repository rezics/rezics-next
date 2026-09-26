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
import { captureDeletionRecoverySet } from '../../../services/account/src/deletion-recovery-set.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable, engageAccessRecoveryFence,
  releaseAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { settleAccountErasures } from '../../../services/main/src/modules/erasure/account.ts';
import { ensureRetentionDomain, readErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold,
  retainErasureCoverage, verifyErasure } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { mirrorAccountDeletionIntent, mirrorAccountDeletionIntents } from
  '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { retainAccountSubjectDeletion } from '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { captureGraphRecoveryCoverage, cutoverRestoredGraphLineage,
  releaseRestoredGraphHold } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'c5'.repeat(32);

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

test('OPS11/OPS12/IAM11: restored backups keep erased payloads and credentials offline until the retained erasure journal reconciles', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `owner-cut-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const stackArgs = ['--profile', 'qa', '--run-id', runId];
  const state = join(root, '.temp', `erasure-restore-${randomUUID()}`);
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
        body: JSON.stringify({ name, email, password }) });
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
        grant_types: ['authorization_code'], scope: 'openid access:manage',
        skip_consent: true, require_pkce: true } });
    const codeVerifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${baseURL}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: browserClient.client_id, redirect_uri: redirectUri, scope: 'openid access:manage',
      state: randomUUID(), resource: apps.ACCOUNT_MAIN_RESOURCE!,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
    const authorized = await fetch(authorize, { headers: { cookie: operator.cookie }, redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    const exchange = await fetch(`${baseURL}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: browserClient.client_id,
        code, redirect_uri: redirectUri, code_verifier: codeVerifier,
        resource: apps.ACCOUNT_MAIN_RESOURCE! }) });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json() as { access_token: string }).access_token;
    const verifier = new AccountAssertionVerifier({ issuer, audience: apps.ACCOUNT_MAIN_RESOURCE!,
      jwksUrl: `${baseURL}/api/auth/jwks`, introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });

    // Access: the erased member's principal and the operator's erasure authority on one Work.
    const work = `https://rezics.com/id/${randomUUID()}`;
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const [erasedPrincipal, operatorPrincipal] = [randomUUID(), randomUUID()];
    await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $3, $4), ($2, $3, $5)`, [erasedPrincipal, operatorPrincipal, issuer, erased.id, operator.id]);
    await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    await access.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`erasure:${work}`]);
    await access.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'erasure.request', now() + interval '1 hour')`, [randomUUID(), operatorPrincipal, actor]);
    await access.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'erasure.request', now() + interval '1 hour')`, [randomUUID(), actor, `erasure:${work}`]);

    // Content: the payload to erase, an unrelated revision and a later erasure target.
    const content = new ContentCore(contentPool);
    const variant = { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
      language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
    let head: string | null = null;
    const save = async (body: string) => {
      const saved = await content.saveDraft({ operationId: `erasure-restore-${randomUUID()}`, variant,
        expectedHead: head, model: 'content-shape-v1', sourceRevision: null,
        provenance: { fixture: 'erasure-restore' }, serializedJson: JSON.stringify({ body }) });
      if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('Content save failed');
      head = saved.revisionId;
      return saved.revisionId;
    };
    const payloadBody = 'private payload that must not come back';
    const [payload, unrelated, later] = [await save(payloadBody), await save('unrelated public text'),
      await save('later erasure target')];

    // Retained frontier: signed coverage head plus the erasure journal epoch it covered.
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    let lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    await initializeFreshGraph(fuseki, lineage);
    const captureAndBackup = async (name: string) => {
      const consumer = `erasure-restore-${randomUUID()}`;
      await initializeRelayCheckpoint(relay, consumer, lineage.dataEpoch);
      const fence = await engageAccessRecoveryFence(access);
      let coverage: Awaited<ReturnType<typeof captureGraphRecoveryCoverage>> | undefined;
      for (let attempt = 0; attempt < 5 && !coverage; attempt++) {
        try { coverage = await captureGraphRecoveryCoverage(fuseki, accountOwner, access, relay, consumer, contentPool); }
        catch (error) {
          if (attempt === 4 || !String(error).includes('Account WAL frontier')) throw error;
          await Bun.sleep(200);
        }
      }
      if (!coverage) throw new Error('recovery coverage did not stabilize');
      const deletionSet = name === 'after-account'
        ? JSON.stringify(sealRecoveryPayload(await captureDeletionRecoverySet(
          accountOwner, access, issuer, erased.id), recoveryKey, 'deletion-recovery-set'))
        : null;
      const sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage,
        recoveryKey, 'graph-recovery-coverage'));
      await retainRecoveryCoverageHead(relay, sealedCoverage, recoveryKey);
      const coveredEpoch = await retainErasureCoverage(relay, consumer);
      const next = { dataEpoch: randomUUID(), routingEpoch:
        (BigInt(lineage.routingEpoch) + 1n).toString() };
      await cutoverRestoredGraphLineage(fuseki, {
        prior: { ...lineage, sequence: '0' }, next });
      const backup = rootCommand(['stack:backup', ...stackArgs], 100_000);
      execFileSync('pg_verifybackup', ['--no-parse-wal', backup], { cwd: state, timeout: 15_000 });
      const restored = await restore(backup, name);
      await releaseRestoredGraphHold(fuseki, restored.access, relay, next,
        { sealedCoverage, hmacKey: recoveryKey, accountPool: restored.account,
          contentPool: restored.content,
          ...(deletionSet ? { deletions: { accountPool: restored.account,
            hmacKey: recoveryKey, sealedSets: [deletionSet] } } : {}) });
      await releaseAccessRecoveryFence(restored.access, fence);
      const restoredFence = await engageAccessRecoveryFence(restored.access);
      await releaseAccessRecoveryFence(access, fence);
      lineage = next;
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60_000);
      for (const owner of ['account', 'content'] as const) {
        await ensureRetentionDomain(relay, { label: `${owner}:backup:${name}:${runId}`, owner,
          store: 'postgresql', custody: 'backup', expiresAt });
      }
      return { backup, restored, restoredFence, coveredEpoch, expiresAt, consumer };
    };
    const restore = async (backup: string, name: string) => {
      const data = join(state, name);
      replayData.push(data);
      cpSync(backup, data, { recursive: true });
      appendFileSync(join(data, 'postgresql.auto.conf'), "\narchive_mode = off\nrestore_command = 'false'\n");
      writeFileSync(join(data, 'recovery.signal'), '');
      const replayPort = await freePort();
      execFileSync('pg_ctl', ['-D', data, '-l', join(state, `${name}.log`),
        '-o', `-h 127.0.0.1 -p ${replayPort} -k ${socketDirectory}`, '-t', '60', '-w', 'start'],
      { cwd: state, timeout: 65_000 });
      const restored = (database: string) => new Pool({ host: '127.0.0.1', port: replayPort, database,
        user: 'postgres', password: compose.POSTGRES_PASSWORD! });
      const owners = { account: restored('account'), access: restored('access'), content: restored('content') };
      pools.push(owners.account, owners.access, owners.content);
      let recovering = true;
      for (let attempt = 0; attempt < 100 && recovering; attempt += 1) {
        recovering = (await owners.account.query<{ recovering: boolean }>(
          'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering ?? true;
        if (recovering) await Bun.sleep(100);
      }
      expect(recovering).toBe(false);
      return owners;
    };
    const credentials = async (pool: Pool, subject: string) => (await pool.query<{ users: string;
      passwords: string; sessions: string }>(`SELECT (SELECT count(*) FROM "user" WHERE id = $1)::text AS users,
      (SELECT count(*) FROM "account" WHERE "userId" = $1)::text AS passwords,
      (SELECT count(*) FROM "session" WHERE "userId" = $1)::text AS sessions`, [subject])).rows[0];
    const exact = async (pool: Pool, id: string) =>
      (await new ContentCore(pool).readExactBatch([id], async ids => new Set(ids)))[0];

    // Backup 1 predates both erasures.
    const first = await captureAndBackup('before');

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

    // Backup 2 follows the Account erasure and predates the Content erasure.
    const second = await captureAndBackup('after-account');
    expect(Number(second.coveredEpoch)).toBeGreaterThan(Number(first.coveredEpoch ?? '0'));

    // OPS11: Content erasure through Main; retention of both earlier backups is explicit.
    const main = createMainApp(fuseki, { environment: { fuseki, lineage, objectDirectory: join(state, 'objects') },
      account: verifier, access: registry, erasures: new ErasureService(relay, contentPool) });
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
    expect(await verifyErasure(relay, { account, access }, accountErasureId, `verify:${accountErasureId}`))
      .toMatchObject({ state: 'reconciled' });
    expect(await verifyErasure(relay, { content: contentPool }, contentErasure.erasureId,
      `verify:${contentErasure.erasureId}`)).toMatchObject({ state: 'reconciled' });
    for (const [erasureId, owner] of [[accountErasureId, 'account'], [contentErasure.erasureId, 'content']] as const) {
      const report = await readErasure(relay, erasureId);
      expect(report).toMatchObject({ stage: 'verified', suppression: 'suppressed', destruction: 'retained' });
      const copies = new Map(report.dispositions.map(entry => [entry.domain, entry]));
      expect(copies.get(`${owner}:postgresql:live`)).toMatchObject({ suppression: 'suppressed', destruction: 'retained' });
      expect(copies.get(`${owner}:backup:before:${runId}`)).toMatchObject({ suppression: 'not_applicable',
        destruction: 'retained', retainedUntil: first.expiresAt.toISOString() });
      expect(copies.get(`${owner}:backup:after-account:${runId}`)).toMatchObject({ suppression: 'not_applicable',
        destruction: 'retained', retainedUntil: second.expiresAt.toISOString() });
    }
    // The live Account owner keeps verifying the operator while restored copies stay isolated.
    const offline = (owners: { access: Pool; content: Pool }) => createMainApp(fuseki, {
      environment: { fuseki, lineage, objectDirectory: join(state, 'objects') }, account: verifier,
      access: new AccessAdmissionRegistry(owners.access), erasures: new ErasureService(relay, owners.content) });
    const readJournal = (mainApp: ReturnType<typeof offline>) => mainApp.handle(new Request(
      `http://main.local/v1/erasures/${contentErasure.erasureId}`, { headers: { authorization: `Bearer ${token}` } }));

    // Backup 1 still holds the erased payload and the erased member's credentials.
    const older = first.restored;
    expect(await exact(older.content, payload)).toMatchObject({ status: 'available',
      serializedJson: JSON.stringify({ body: payloadBody }) });
    expect(await credentials(older.account, erased.id)).toEqual({ users: '1', passwords: '1', sessions: '1' });
    // OPS12: protected reads and new effects stay offline on the fenced restore.
    const olderMain = offline(older);
    expect((await readJournal(olderMain)).status).toBe(503);
    await expect(new AccessAdmissionRegistry(older.access).canReadWork({ issuer, subject: operator.id }, actor, work))
      .rejects.toBeInstanceOf(AdmissionUnavailable);
    await expect(releaseErasureRestoreHold(relay, older.access, randomUUID(), first.restoredFence))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    const olderPass = await reconcileRestoredErasures(relay, older,
      { operationId: `restore-before-${runId}`, consumer: first.consumer, replay: true });
    expect(olderPass).toMatchObject({ state: 'held' });
    expect(olderPass.counts.conflict).toBe(2);
    expect(olderPass.counts.replayed).toBe(1);
    await expect(releaseErasureRestoreHold(relay, older.access, olderPass.reconciliationId, first.restoredFence))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    expect((await readJournal(olderMain)).status).toBe(503);
    expect(await credentials(older.account, erased.id)).toMatchObject({ users: '1' });

    // Backup 2: credentials stay erased, but it lacks the later Content erasure.
    const current = second.restored;
    expect(await credentials(current.account, erased.id)).toEqual({ users: '0', passwords: '0', sessions: '0' });
    expect(await exact(current.content, payload)).toMatchObject({ status: 'available' });
    const currentMain = offline(current);
    const unreplayed = await reconcileRestoredErasures(relay, current,
      { operationId: `restore-hold-${runId}`, consumer: second.consumer, replay: false });
    expect(unreplayed).toMatchObject({ state: 'held', counts: { conflict: 1 } });
    await expect(releaseErasureRestoreHold(relay, current.access, unreplayed.reconciliationId, second.restoredFence))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    expect((await readJournal(currentMain)).status).toBe(503);
    const replayed = await reconcileRestoredErasures(relay, current,
      { operationId: `restore-replay-${runId}`, consumer: second.consumer, replay: true });
    expect(replayed).toMatchObject({ state: 'reconciled', counts: { replayed: 1, erased: 1, matched: 1 } });
    expect(await exact(current.content, payload)).toMatchObject({ status: 'erased' });

    // A later journal entry makes that reconciliation stale before release.
    const laterErasure = await erase([later]);
    await expect(releaseErasureRestoreHold(relay, current.access, replayed.reconciliationId, second.restoredFence))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    expect((await readJournal(currentMain)).status).toBe(503);
    const final = await reconcileRestoredErasures(relay, current,
      { operationId: `restore-final-${runId}`, consumer: second.consumer, replay: true });
    expect(final).toMatchObject({ state: 'reconciled', erasureEpoch: laterErasure.erasureEpoch });
    await releaseErasureRestoreHold(relay, current.access, final.reconciliationId, second.restoredFence);

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
  } finally {
    await app?.stop();
    await Promise.allSettled(pools.map(pool => pool.end()));
    for (const data of replayData) {
      if (spawnSync('pg_ctl', ['-D', data, 'status'], { cwd: state, timeout: 5_000 }).status === 0) {
        execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-t', '10', '-w', 'stop'], { cwd: state, timeout: 15_000 });
      }
    }
    try { if (started) rootCommand(['stack:reset', ...stackArgs], 120_000); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
}, 420_000);
