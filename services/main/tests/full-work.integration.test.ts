import { test, expect } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../../account/src/auth.ts';
import { createAccountApp } from '../../account/src/app.ts';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionDenied } from '../src/modules/access/admission.ts';
import { mirrorAccountDeletionIntent } from '../src/modules/outbox/account-deletion-journal.ts';
import { retainAccountSubjectDeletion } from '../src/modules/outbox/account-subject-deletion.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { initializeFreshGraph, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { metadataWorkEditDigest } from '../src/modules/work/edit.ts';
import { readTextContributionReceipt, textContributionDigest } from '../src/modules/contribution/draft.ts';
import { readTextContributionEditReceipt, textContributionEditDigest } from '../src/modules/contribution/edit.ts';
import { readTextPublicationReceipt, textPublicationDigest,
  type PublishTextContributionInput } from '../src/modules/contribution/publish.ts';
import { mainSelectionDigest, readMainSelectionReceipt,
  type SelectMainDefaultInput } from '../src/modules/work/select-main.ts';
import { readSpaceCreationReceipt, spaceCreationDigest } from '../src/modules/space/create.ts';
import { classificationContextDigest, readClassificationContextReceipt } from '../src/modules/classification/context.ts';
import { classificationPropositionDigest, readClassificationPropositionReceipt } from '../src/modules/classification/proposition.ts';
import { classificationDecisionDigest, readClassificationDecisionReceipt } from '../src/modules/classification/decision.ts';
import { ratingContextDigest, readRatingContextReceipt } from '../src/modules/rating/context.ts';
import { readStandingRatingReceipt, standingRatingDigest } from '../src/modules/rating/observation.ts';
import { readRealmSelectionReceipt, realmSelectionDigest,
  type SelectRealmLocalInput } from '../src/modules/work/select-realm.ts';
import { readRealmRejectionReceipt, realmRejectionDigest,
  type RejectRealmLocalInput } from '../src/modules/work/reject-realm.ts';
import { strongRevokeWorkPrincipal, strongRevokeWorkScope } from '../src/modules/work/strong-revoke.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no free port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('IAM01/IAM07/IAM10/SYS02/G3 partial: real Account to Access to Main HTTP to Fuseki', async () => {
  const fusekiHome = Bun.env.REZICS_FUSEKI_HOME;
  const jenaHome = Bun.env.REZICS_JENA_HOME;
  const javaHome = Bun.env.REZICS_JAVA_HOME;
  if (!fusekiHome || !jenaHome || !javaHome) throw new Error('Set REZICS_FUSEKI_HOME, REZICS_JENA_HOME and REZICS_JAVA_HOME');
  const state = join(root, '.temp', `full-work-${Bun.randomUUIDv7()}`);
  const base = join(state, 'fuseki');
  mkdirSync(join(base, 'databases/rezics/tdb2'), { recursive: true });
  mkdirSync(join(base, 'databases/rezics/lucene'), { recursive: true });
  copyFileSync(join(root, 'docs/operations/examples/fuseki-text.ttl'), join(base, 'fuseki-text.ttl'));
  const fusekiPort = await freePort();
  const fusekiLog = openSync(join(state, 'fuseki.log'), 'w');
  const fusekiProcess = spawn(join(fusekiHome, 'fuseki-server'), [
    '--localhost', `--port=${fusekiPort}`, '--no-cors', '--timeout=10000', `--config=${join(base, 'fuseki-text.ttl')}`,
  ], { cwd: base, env: { ...process.env, JAVA_HOME: javaHome, FUSEKI_HOME: fusekiHome,
    FUSEKI_BASE: base, MAIN: 'main', JVM_ARGS: '-Xms128m -Xmx1g' }, stdio: ['ignore', fusekiLog, fusekiLog] });
  closeSync(fusekiLog);
  const fuseki = new FusekiClient(`http://127.0.0.1:${fusekiPort}/rezics`);
  const pgData = join(state, 'pgdata');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  let postgresStarted = false;
  let pool: Pool | undefined;
  let accountApp: ReturnType<typeof createAccountApp> | undefined;
  let mainApp: ReturnType<typeof createMainApp> | undefined;
  try {
    for (let i = 0; i < 120; i++) {
      try { if ((await fuseki.query('ASK {}')).boolean === true) break; } catch { /* starting */ }
      if (i === 119) throw new Error('Fuseki did not start');
      await Bun.sleep(250);
    }
    execFileSync('initdb', ['-D', pgData, '-A', 'trust', '--no-instructions'], { cwd: state });
    const pgPort = await freePort();
    execFileSync('pg_ctl', ['-D', pgData, '-l', join(state, 'postgres.log'),
      '-o', `-h 127.0.0.1 -p ${pgPort} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    postgresStarted = true;
    pool = new Pool({ host: '127.0.0.1', port: pgPort, user: process.env.USER, database: 'postgres' });
    const accountPort = await freePort();
    const accountBase = `http://127.0.0.1:${accountPort}`;
    const resource = 'https://main.rezics.test';
    const operators = new Set<string>();
    const access = new AccessAdmissionRegistry(pool);
    const config = { baseURL: accountBase, secret: 'full-work-local-integration-secret-value-32',
      resource, pool, operatorUserIds: operators,
      accessDeletionFence: async (subject: string) => {
        const fence = await access.strongDeactivateAccountSubject(`${accountBase}/api/auth`, subject);
        if (fence) await mirrorAccountDeletionIntent(pool!, pool!, fence.principalId, fence.enforcementEpoch);
        await retainAccountSubjectDeletion(pool!, `${accountBase}/api/auth`, subject);
      } };
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    const auth = createAccountAuth(config);
    accountApp = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port: accountPort });
    const discovery = await fetch(`${accountBase}/api/auth/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    const metadata = await discovery.json() as { issuer: string; jwks_uri: string };
    const operatorSignUp = await fetch(`${accountBase}/api/auth/sign-up/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: accountBase },
      body: JSON.stringify({ name: 'Account Operator', email: 'operator@example.test',
        password: 'correct horse battery staple' }) });
    expect(operatorSignUp.status).toBe(200);
    const operatorCookie = operatorSignUp.headers.get('set-cookie')!;
    const operator = await operatorSignUp.json() as { user: { id: string } };
    operators.add(operator.user.id);
    const signUp = await fetch(`${accountBase}/api/auth/sign-up/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: accountBase },
      body: JSON.stringify({ name: 'Full Work User', email: 'full-work@example.test', password: 'correct horse battery staple' }) });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get('set-cookie')!;
    const user = await signUp.json() as { user: { id: string } };
    const confidential = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: operatorCookie, origin: accountBase }),
      body: { client_name: 'Main verifier', scope: 'work:create', token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['client_credentials'], client_credentials_scopes: ['work:create'] },
    });
    const callback = 'https://rp.rezics.test/callback';
    const publicClient = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: operatorCookie, origin: accountBase }),
      body: { client_name: 'Full Work RP', redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create work:edit work:read space:create realm:adopt realm:reject realm:classify classification:define classification:decide rating:configure rating:submit rating:read', skip_consent: true, require_pkce: true },
    });
    const pkceVerifier = 'b'.repeat(64);
    const authorize = new URL(`${accountBase}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: publicClient.client_id,
      redirect_uri: callback, scope: 'openid work:create work:edit work:read space:create realm:adopt realm:reject realm:classify classification:define classification:decide rating:configure rating:submit rating:read', state: 'full-work-state',
      code_challenge: createHash('sha256').update(pkceVerifier).digest('base64url'),
      code_challenge_method: 'S256', resource })) authorize.searchParams.set(key, value);
    const authorization = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
    expect(authorization.status).toBe(302);
    const code = new URL(authorization.headers.get('location')!).searchParams.get('code')!;
    const exchange = await fetch(`${accountBase}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: publicClient.client_id,
        code, redirect_uri: callback, code_verifier: pkceVerifier, resource }) });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json() as { access_token: string }).access_token;
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/001_admission.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/002_claim_and_seal.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/003_recovery_fence.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/004_principal_fence.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/005_account_deletion_fence.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/access/006_account_deletion_journal_scan.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/relay/001_delivery.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/relay/003_retained_batches.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/relay/004_account_deletion_journal.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/relay/006_account_subject_deletion.sql'), 'utf8'));
    const principalId = Bun.randomUUIDv7();
    const actor = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)`,
      [principalId, metadata.issuer, user.user.id]);
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root')");
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`, [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '1 hour')`, [Bun.randomUUIDv7(), actor]);
    const lineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '1' };
    await initializeFreshGraph(fuseki, lineage);
    const environment: WorkActivationEnvironment = { fuseki, lineage,
      objectDirectory: join(state, 'objects'), candidateDirectory: join(state, 'candidates'),
      repositoryRoot: root, jenaHome, javaHome, python: 'python3' };
    const verifier = new AccountAssertionVerifier({ issuer: metadata.issuer, audience: resource,
      jwksUrl: metadata.jwks_uri, introspectUrl: `${accountBase}/api/auth/oauth2/introspect`,
      clientId: confidential.client_id, clientSecret: confidential.client_secret! });
    const mainPort = await freePort();
    mainApp = createMainApp(fuseki, { environment, account: verifier, access })
      .listen({ hostname: '127.0.0.1', port: mainPort });
    const body = { profile: 'metadata-only-v1', title: 'Real authenticated Work', actingSubject: actor };
    const command = (bearer: string, key: string) => fetch(`http://127.0.0.1:${mainPort}/v1/works`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': key,
        'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const created = await command(token, 'real-account-create');
    expect(created.status).toBe(201);
    const result = await created.json() as { work: string; mainVersion: string; workRevision: string;
      sourcePosition: { sequence: string } };
    expect(result.sourcePosition.sequence).toBe('1');
    expect(result.work).toMatch(/^https:\/\/rezics\.com\/id\//);
    const replay = await command(token, 'real-account-create');
    expect(replay.status).toBe(200);
    expect((await replay.json() as { work: string }).work).toBe(result.work);
    const contributionScope = `contribution:create:${result.work}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [contributionScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, contributionScope]);
    const draftText = 'Private draft body, never a public MatchUnit';
    const contributionBody = { profile: 'text-contribution-v1', work: result.work,
      language: 'en', body: draftText, actingSubject: actor };
    const createContribution = (key: string, value = contributionBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/contributions`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' }, body: JSON.stringify(value) });
    const contributionResponse = await createContribution('real-contribution-draft');
    expect(contributionResponse.status).toBe(201);
    const contributionResult = await contributionResponse.json() as {
      contribution: string; draftRevision: string; replayed: boolean;
      sourcePosition: { sequence: string } };
    expect(contributionResult.sourcePosition.sequence).toBe('2');
    expect(contributionResult.contribution).not.toBe(result.work);
    expect(contributionResult.replayed).toBe(false);
    const replayContribution = await createContribution('real-contribution-draft');
    expect(replayContribution.status).toBe(200);
    expect((await replayContribution.json() as { contribution: string; draftRevision: string }))
      .toMatchObject({ contribution: contributionResult.contribution,
        draftRevision: contributionResult.draftRevision });
    expect((await createContribution('real-contribution-draft',
      { ...contributionBody, body: 'changed' })).status).toBe(409);
    const alternativeText = 'Alternative Realm B selected body';
    const alternativeDraftResponse = await createContribution('realm-b-draft',
      { ...contributionBody, body: alternativeText });
    expect(alternativeDraftResponse.status).toBe(201);
    const alternativeDraft = await alternativeDraftResponse.json() as {
      contribution: string; draftRevision: string };
    const draftRead = () => fetch(`http://127.0.0.1:${mainPort}/v1/contributions/${
      contributionResult.contribution.split('/').at(-1)}/drafts/${
      contributionResult.draftRevision.split('/').at(-1)}?actingSubject=${encodeURIComponent(actor)}`,
    { headers: { authorization: `Bearer ${token}` } });
    expect((await draftRead()).status).toBe(404);
    const draftReadScope = `contribution:read:${contributionResult.contribution}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [draftReadScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.read', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    const draftReadGrant = Bun.randomUUIDv7();
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.read', now() + interval '1 hour')`,
    [draftReadGrant, actor, draftReadScope]);
    expect((await draftRead()).status).toBe(200);
    expect((await (await draftRead()).json() as { body: string }).body).toBe(draftText);
    const publicBody = await fuseki.query(`ASK { GRAPH ?graph { ?subject ?predicate "${draftText}" } }`);
    expect(publicBody.boolean).toBe(false);
    const draftEvent = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      ASK { GRAPH <urn:rezics:graph:outbox> {
        ?batch a rv:OutboxBatch ; rv:sequence 2 ; rv:eventCount 1 ; rv:event ?event .
        ?event a rv:ContributionDraftCreatedEvent ; rv:contribution <${contributionResult.contribution}> .
      } }`);
    expect(draftEvent.boolean).toBe(true);
    await initializeRelayCheckpoint(pool, 'contribution-proof', lineage.dataEpoch);
    expect((await relayMainOutboxOnce(fuseki, pool, 'contribution-proof'))?.sequence).toBe('1');
    expect((await relayMainOutboxOnce(fuseki, pool, 'contribution-proof'))?.sequence).toBe('2');
    const retainedDraft = await pool.query<{ envelope: { type: string; data: {
      receipt: { contribution: string; draftManifest: string } } } }>(
    'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = 2',
    [lineage.dataEpoch]);
    expect(retainedDraft.rows[0]?.envelope.type).toBe('com.rezics.contribution.draft-created.v1');
    expect(retainedDraft.rows[0]?.envelope.data.receipt.contribution).toBe(contributionResult.contribution);
    expect(retainedDraft.rows[0]?.envelope.data.receipt.draftManifest).toMatch(/^urn:rezics:sha256:/);
    expect(JSON.stringify(retainedDraft.rows[0]?.envelope)).not.toContain(draftText);
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [draftReadGrant]);
    expect((await draftRead()).status).toBe(404);
    const pendingDraftBody = { ...contributionBody, body: 'Fenced pending draft' };
    const pendingDraft = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: contributionScope,
    action: 'contribution.create', idempotencyKey: 'pending-contribution-draft',
    requestDigest: textContributionDigest(pendingDraftBody) });
    await access.claim(pendingDraft.id, pendingDraft.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, contributionScope, '0')).toEqual({
      scope: contributionScope, authorityEpoch: '1', status: 'complete', pending: 0,
    });
    expect((await readTextContributionReceipt(environment, pendingDraft.id))?.outcome).toBe('cancelled');
    expect((await relayMainOutboxOnce(fuseki, pool, 'contribution-proof'))?.sequence).toBe('3');
    expect((await relayMainOutboxOnce(fuseki, pool, 'contribution-proof'))?.sequence).toBe('4');
    const retainedCancellation = await pool.query<{ envelope: { type: string; data: {
      receipt: { outcome: string; action: string } } } }>(
    'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = 4',
    [lineage.dataEpoch]);
    expect(retainedCancellation.rows[0]?.envelope.type)
      .toBe('com.rezics.contribution.admission-cancelled.v1');
    expect(retainedCancellation.rows[0]?.envelope.data.receipt)
      .toMatchObject({ outcome: 'cancelled', action: 'contribution.create' });
    expect((await createContribution('pending-contribution-draft', pendingDraftBody)).status).toBe(409);
    expect((await createContribution('new-after-contribution-fence')).status).toBe(403);
    const contributionEditScope = `contribution:edit:${contributionResult.contribution}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [contributionEditScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.edit', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.edit', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, contributionEditScope]);
    const editedText = 'Updated private draft, still not public';
    const contributionEditBody = { profile: 'text-contribution-v1',
      contribution: contributionResult.contribution, expectedHead: contributionResult.draftRevision,
      body: editedText, actingSubject: actor };
    const editContribution = (key: string, value = contributionEditBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/contribution-edits`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' }, body: JSON.stringify(value) });
    const editedContribution = await editContribution('real-contribution-edit');
    expect(editedContribution.status).toBe(200);
    const contributionEditResult = await editedContribution.json() as {
      contribution: string; draftRevision: string; predecessor: string; replayed: boolean };
    expect(contributionEditResult).toMatchObject({
      contribution: contributionResult.contribution,
      predecessor: contributionResult.draftRevision, replayed: false,
    });
    expect(contributionEditResult.draftRevision).not.toBe(contributionResult.draftRevision);
    const editContributionReplay = await editContribution('real-contribution-edit');
    expect(editContributionReplay.status).toBe(200);
    expect((await editContributionReplay.json() as { draftRevision: string; replayed: boolean }))
      .toMatchObject({ draftRevision: contributionEditResult.draftRevision, replayed: true });
    const staleContributionEdit = await editContribution('stale-contribution-edit',
      { ...contributionEditBody, body: 'Stale draft attempt' });
    expect(staleContributionEdit.status).toBe(409);
    expect(await staleContributionEdit.json()).toMatchObject({ code: 'stale_head',
      title: 'Expected Contribution draft revision is stale' });
    await pool.query('UPDATE access.permission_grant SET active = true WHERE id = $1', [draftReadGrant]);
    expect((await (await draftRead()).json() as { body: string }).body).toBe(draftText);
    const editedDraftRead = await fetch(`http://127.0.0.1:${mainPort}/v1/contributions/${
      contributionResult.contribution.split('/').at(-1)}/drafts/${
      contributionEditResult.draftRevision.split('/').at(-1)}?actingSubject=${encodeURIComponent(actor)}`,
    { headers: { authorization: `Bearer ${token}` } });
    expect(editedDraftRead.status).toBe(200);
    expect((await editedDraftRead.json() as { body: string; predecessor: string }))
      .toMatchObject({ body: editedText, predecessor: contributionResult.draftRevision });
    expect((await fuseki.query(`ASK { GRAPH ?graph { ?subject ?predicate "${editedText}" } }`)).boolean)
      .toBe(false);
    const raceBodyA = { ...contributionEditBody,
      expectedHead: contributionEditResult.draftRevision, body: 'Concurrent draft A' };
    const raceBodyB = { ...contributionEditBody,
      expectedHead: contributionEditResult.draftRevision, body: 'Concurrent draft B' };
    const raceResponses = await Promise.all([
      editContribution('contribution-race-a', raceBodyA),
      editContribution('contribution-race-b', raceBodyB),
    ]);
    expect(raceResponses.map(response => response.status).sort()).toEqual([200, 409]);
    const raceWinner = await raceResponses.find(response => response.status === 200)!.json() as {
      draftRevision: string; predecessor: string };
    expect(raceWinner.predecessor).toBe(contributionEditResult.draftRevision);
    const raceWinnerBody = await fetch(`http://127.0.0.1:${mainPort}/v1/contributions/${
      contributionResult.contribution.split('/').at(-1)}/drafts/${
      raceWinner.draftRevision.split('/').at(-1)}?actingSubject=${encodeURIComponent(actor)}`,
    { headers: { authorization: `Bearer ${token}` } });
    expect(raceWinnerBody.status).toBe(200);
    const winningText = (await raceWinnerBody.json() as { body: string }).body;
    expect(['Concurrent draft A', 'Concurrent draft B']).toContain(winningText);
    const pendingContributionEditBody = { ...contributionEditBody,
      expectedHead: raceWinner.draftRevision, body: 'Fenced edit body' };
    const pendingContributionEdit = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: contributionEditScope,
    action: 'contribution.edit', idempotencyKey: 'pending-contribution-edit',
    requestDigest: textContributionEditDigest(pendingContributionEditBody) });
    await access.claim(pendingContributionEdit.id, pendingContributionEdit.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, contributionEditScope, '0'))
      .toEqual({ scope: contributionEditScope, authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readTextContributionEditReceipt(environment, pendingContributionEdit.id))?.outcome)
      .toBe('cancelled');
    expect((await editContribution('pending-contribution-edit', pendingContributionEditBody)).status)
      .toBe(404);
    expect((await editContribution('new-after-contribution-edit-fence', pendingContributionEditBody)).status)
      .toBe(403);
    for (const [sequence, type] of [
      ['5', 'com.rezics.contribution.draft-edited.v1'],
      ['6', 'com.rezics.contribution.draft-edit-rejected.v1'],
      ['7', 'com.rezics.contribution.draft-edited.v1'],
      ['8', 'com.rezics.contribution.draft-edit-rejected.v1'],
      ['9', 'com.rezics.contribution.admission-cancelled.v1'],
    ]) {
      expect((await relayMainOutboxOnce(fuseki, pool, 'contribution-proof'))?.sequence).toBe(sequence);
      const event = await pool.query<{ envelope: { type: string } }>(
        'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, sequence]);
      expect(event.rows[0]?.envelope.type).toBe(type);
      expect(JSON.stringify(event.rows[0]?.envelope)).not.toContain(editedText);
    }
    const publicationScope = `contribution:publish:${contributionResult.contribution}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [publicationScope]);
    const publicationBody = { profile: 'text-publication-v1',
      contribution: contributionResult.contribution, expectedDraftHead: raceWinner.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution',
      disclosure: 'public', actingSubject: actor } as const;
    const publish = (key: string, value: PublishTextContributionInput & {
      profile: 'text-publication-v1' } = publicationBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/contribution-publications`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' }, body: JSON.stringify(value) });
    expect((await publish('denied-publication')).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.publish', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.publish', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, publicationScope]);
    const published = await publish('real-contribution-publication');
    expect(published.status).toBe(201);
    const publication = await published.json() as {
      contribution: string; publicationDecision: string; selectedDraft: string;
      predecessor: string | null; replayed: boolean; sourcePosition: { sequence: string } };
    expect(publication).toMatchObject({ contribution: contributionResult.contribution,
      selectedDraft: raceWinner.draftRevision, predecessor: null, replayed: false,
      sourcePosition: { sequence: '10' } });
    const publicationReplay = await publish('real-contribution-publication');
    expect(publicationReplay.status).toBe(200);
    expect(await publicationReplay.json()).toMatchObject({
      publicationDecision: publication.publicationDecision, replayed: true });
    const alternativePublicationScope = `contribution:publish:${alternativeDraft.contribution}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [alternativePublicationScope]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.publish', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, alternativePublicationScope]);
    const alternativePublicationResponse = await publish('realm-b-publication', {
      profile: 'text-publication-v1', contribution: alternativeDraft.contribution,
      expectedDraftHead: alternativeDraft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor });
    expect(alternativePublicationResponse.status).toBe(201);
    const alternativePublication = await alternativePublicationResponse.json() as {
      publicationDecision: string };
    const publicationGraph = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:current> {
        <${contributionResult.contribution}> rv:publicationHead <${publication.publicationDecision}> .
      }
      GRAPH <urn:rezics:graph:revisions> {
        <${publication.publicationDecision}> rv:selectedDraft <${raceWinner.draftRevision}> ;
          rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .
      }
    }`);
    expect(publicationGraph.boolean).toBe(true);
    const stalePublication = await publish('stale-contribution-publication');
    expect(stalePublication.status).toBe(409);
    expect(await stalePublication.json()).toMatchObject({ code: 'stale_head' });
    const otherActor = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [otherActor]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.publish', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, otherActor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'contribution.publish', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), otherActor, publicationScope]);
    expect((await publish('nonauthor-publication', { ...publicationBody,
      expectedPublicationHead: publication.publicationDecision,
      actingSubject: otherActor })).status).toBe(404);
    const pendingPublicationBody = { ...publicationBody,
      expectedPublicationHead: publication.publicationDecision };
    const pendingPublication = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: publicationScope,
    action: 'contribution.publish', idempotencyKey: 'pending-publication',
    requestDigest: textPublicationDigest(pendingPublicationBody) });
    await access.claim(pendingPublication.id, pendingPublication.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, publicationScope, '0'))
      .toEqual({ scope: publicationScope, authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readTextPublicationReceipt(environment, pendingPublication.id))?.outcome)
      .toBe('cancelled');
    expect((await publish('pending-publication', pendingPublicationBody)).status).toBe(404);
    expect((await publish('new-after-publication-fence', pendingPublicationBody)).status).toBe(403);
    for (const [sequence, type] of [
      ['10', 'com.rezics.contribution.eligibility-recorded.v1'],
      ['11', 'com.rezics.contribution.eligibility-recorded.v1'],
      ['12', 'com.rezics.contribution.publication-rejected.v1'],
      ['13', 'com.rezics.contribution.publication-cancelled.v1'],
      ['14', 'com.rezics.contribution.publication-cancelled.v1'],
    ]) {
      expect((await relayMainOutboxOnce(fuseki, pool, 'contribution-proof'))?.sequence).toBe(sequence);
      const event = await pool.query<{ envelope: { type: string; data: {
        receipt: { publicationDecision?: string; selectedDraft?: string; publicationManifest?: string } } } }>(
        'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, sequence]);
      expect(event.rows[0]?.envelope.type).toBe(type);
      expect(JSON.stringify(event.rows[0]?.envelope)).not.toContain('Concurrent draft');
      if (sequence === '9') expect(event.rows[0]?.envelope.data.receipt).toMatchObject({
        publicationDecision: publication.publicationDecision,
        selectedDraft: raceWinner.draftRevision,
        publicationManifest: expect.stringMatching(/^urn:rezics:sha256:/),
      });
    }
    expect((await fuseki.query(`ASK { GRAPH ?graph { ?subject ?predicate ?body .
      FILTER(isLiteral(?body) && (STR(?body) = "Concurrent draft A" ||
        STR(?body) = "Concurrent draft B")) } }`)).boolean).toBe(false);
    expect((await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ?graph { ?unit a rv:MatchUnit } }`)).boolean).toBe(false);
    const mainId = result.mainVersion.split('/').at(-1);
    const publicSelectionRead = () => fetch(`http://127.0.0.1:${mainPort}/v1/main-versions/${mainId}/selection`);
    expect((await publicSelectionRead()).status).toBe(404);
    const selectionScope = `publication:select:${result.mainVersion}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [selectionScope]);
    const selectionBody = { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: result.mainVersion },
      work: result.work, contribution: contributionResult.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer', actingSubject: actor } as const;
    const select = (key: string, value: SelectMainDefaultInput & {
      profile: 'main-default-selection-v1' } = selectionBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/publication-selections`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' }, body: JSON.stringify(value) });
    expect((await select('denied-main-selection')).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'publication.select', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'publication.select', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, selectionScope]);
    const selectedResponse = await select('real-main-selection');
    expect(selectedResponse.status).toBe(201);
    const selected = await selectedResponse.json() as {
      selection: string; matchUnit: string; selectedDraft: string;
      predecessor: string | null; replayed: boolean; sourcePosition: { sequence: string } };
    expect(selected).toMatchObject({ selectedDraft: raceWinner.draftRevision,
      predecessor: null, replayed: false, sourcePosition: { sequence: '15' } });
    expect((await select('real-main-selection')).status).toBe(200);
    const publicSelection = await publicSelectionRead();
    expect(publicSelection.status).toBe(200);
    expect(await publicSelection.json()).toMatchObject({ body: winningText,
      selection: selected.selection, selectedDraft: raceWinner.draftRevision });
    const textMatch = await fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
      PREFIX rv: <https://rezics.com/vocab/> SELECT ?unit WHERE {
      GRAPH <urn:rezics:search:public> {
        (?unit ?score) text:query (rv:searchBody "Concurrent") .
        ?unit a rv:MatchUnit ; rv:mainVersion <${result.mainVersion}> .
      }
    }`);
    expect(textMatch.results?.bindings.map(row => row.unit?.value))
      .toEqual([selected.matchUnit]);
    const publicQuery = (phrase: string, language: string | null = null) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/queries`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'public-main-phrase-v1', phrase, language }) });
    const searchResponse = await publicQuery('Concurrent');
    expect(searchResponse.status).toBe(200);
    expect(await searchResponse.json()).toMatchObject({ complete: true, population: 1,
      total: 1, results: [{ mainVersion: result.mainVersion,
        selection: selected.selection, matchUnit: selected.matchUnit }] });
    expect(await (await publicQuery('private draft')).json()).toMatchObject({
      complete: true, total: 0 });
    expect(await (await publicQuery('Concurrent', 'zh')).json()).toMatchObject({
      complete: true, total: 0 });
    const staleSelection = await select('stale-main-selection');
    expect(staleSelection.status).toBe(409);
    expect(await staleSelection.json()).toMatchObject({ code: 'stale_head' });
    const unrelatedUnit = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:search:public> { <${unrelatedUnit}> a rv:MatchUnit ;
        rv:searchBody "Other Work sentinel"@en . } }`);
    const replacementBody = { ...selectionBody, expectedSelectionHead: selected.selection };
    const replacementRace = await Promise.all([
      select('replacement-main-selection-a', replacementBody),
      select('replacement-main-selection-b', replacementBody),
    ]);
    expect(replacementRace.map(response => response.status).sort()).toEqual([201, 409]);
    const replacementResponse = replacementRace.find(response => response.status === 201)!;
    const replacement = await replacementResponse.json() as { selection: string; matchUnit: string };
    expect(replacement.selection).not.toBe(selected.selection);
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:search:public> {
      <${selected.matchUnit}> ?p ?o } }`)).boolean).toBe(false);
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:search:public> {
      <${unrelatedUnit}> a <https://rezics.com/vocab/MatchUnit> } }`)).boolean).toBe(true);
    expect((await publicSelectionRead()).status).toBe(200);
    expect(await (await publicQuery('Concurrent')).json()).toMatchObject({
      complete: true, total: 1, results: [{ matchUnit: replacement.matchUnit }] });
    await fuseki.update(`DELETE WHERE { GRAPH <urn:rezics:search:public> {
      <${unrelatedUnit}> ?p ?o } }`);
    const fillerUnits = Array.from({ length: 100 }, () => `https://rezics.com/id/${Bun.randomUUIDv7()}`);
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:search:public> {
        ${fillerUnits.map((unit, index) => `<${unit}> a rv:MatchUnit ;
          rv:mainVersion <${result.mainVersion}> ; rv:context <${result.mainVersion}> ;
          rv:searchBody "Budget filler ${index}"@en .`).join('\n')}
      }
    }`);
    const exhausted = await publicQuery('Concurrent');
    expect(exhausted.status).toBe(422);
    expect(await exhausted.json()).toMatchObject({ code: 'query_budget_exceeded' });
    await fuseki.update(`DELETE { GRAPH <urn:rezics:search:public> { ?unit ?p ?o } }
      WHERE { VALUES ?unit { ${fillerUnits.map(unit => `<${unit}>`).join(' ')} }
        GRAPH <urn:rezics:search:public> { ?unit ?p ?o } }`);
    expect(await (await publicQuery('Concurrent')).json()).toMatchObject({
      complete: true, population: 1, total: 1 });
    const pendingSelectionBody = { ...selectionBody,
      expectedSelectionHead: replacement.selection };
    const pendingSelection = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: selectionScope,
    action: 'publication.select', idempotencyKey: 'pending-main-selection',
    requestDigest: mainSelectionDigest(pendingSelectionBody) });
    await access.claim(pendingSelection.id, pendingSelection.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, selectionScope, '0'))
      .toEqual({ scope: selectionScope, authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readMainSelectionReceipt(environment, pendingSelection.id))?.outcome).toBe('cancelled');
    expect((await select('pending-main-selection', pendingSelectionBody)).status).toBe(404);
    expect((await select('new-after-selection-fence', pendingSelectionBody)).status).toBe(403);
    for (const [sequence, type] of [
      ['15', 'com.rezics.publication.selection-changed.v1'],
      ['16', 'com.rezics.publication.selection-rejected.v1'],
      ['17', 'com.rezics.publication.selection-changed.v1'],
      ['18', 'com.rezics.publication.selection-rejected.v1'],
      ['19', 'com.rezics.publication.selection-cancelled.v1'],
    ]) {
      expect((await relayMainOutboxOnce(fuseki, pool, 'contribution-proof'))?.sequence).toBe(sequence);
      const event = await pool.query<{ envelope: { type: string; data: {
        receipt: { selection?: string; selectionManifest?: string; matchUnit?: string } } } }>(
        'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, sequence]);
      expect(event.rows[0]?.envelope.type).toBe(type);
      expect(JSON.stringify(event.rows[0]?.envelope)).not.toContain(winningText);
      if (sequence === '15') expect(event.rows[0]?.envelope.data.receipt).toMatchObject({
        selection: selected.selection, matchUnit: selected.matchUnit,
        selectionManifest: expect.stringMatching(/^urn:rezics:sha256:/),
      });
    }
    const editScope = `work:edit:${result.work}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [editScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.edit', now() + interval '1 hour')`, [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.edit', now() + interval '1 hour')`, [Bun.randomUUIDv7(), actor, editScope]);
    const editBody = { profile: 'metadata-only-v1', work: result.work, expectedHead: result.workRevision,
      title: 'Real authenticated updated Work', actingSubject: actor };
    const edit = (key: string, value = editBody) => fetch(`http://127.0.0.1:${mainPort}/v1/content-edits`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
        'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    const edited = await edit('real-account-edit');
    expect(edited.status).toBe(200);
    const editResult = await edited.json() as { revision: string; predecessor: string; replayed: boolean };
    expect(editResult.predecessor).toBe(result.workRevision);
    expect(editResult.revision).not.toBe(result.workRevision);
    expect(editResult.replayed).toBe(false);
    const editReplay = await edit('real-account-edit');
    expect(editReplay.status).toBe(200);
    expect((await editReplay.json() as { revision: string; replayed: boolean })).toMatchObject({
      revision: editResult.revision, replayed: true,
    });
    const stale = await edit('stale-head-edit', { ...editBody, title: 'Stale attempt' });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { code: string }).code).toBe('stale_head');
    const readScope = `work:read:${result.work}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [readScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.read', now() + interval '1 hour')`, [Bun.randomUUIDv7(), principalId, actor]);
    const readGrant = Bun.randomUUIDv7();
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.read', now() + interval '1 hour')`, [readGrant, actor, readScope]);
    const read = (revision: string) => fetch(`http://127.0.0.1:${mainPort}/v1/revisions/${revision.split('/').at(-1)}?actingSubject=${encodeURIComponent(actor)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const oldRevision = await read(result.workRevision);
    expect(oldRevision.status).toBe(200);
    expect((await oldRevision.json() as { title: string }).title).toBe('Real authenticated Work');
    const currentRevision = await read(editResult.revision);
    expect(currentRevision.status).toBe(200);
    expect((await currentRevision.json() as { title: string; predecessor: string })).toMatchObject({
      title: 'Real authenticated updated Work', predecessor: result.workRevision,
    });
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [readGrant]);
    const hidden = await read(result.workRevision);
    expect(hidden.status).toBe(404);
    await pool.query('UPDATE access.permission_grant SET active = true WHERE id = $1', [readGrant]);
    const pendingTitle = 'Cancelled before edit dispatch';
    const pendingEdit = await access.register({ principal: { issuer: metadata.issuer, subject: user.user.id },
      actingSubject: actor, scope: editScope, action: 'work.edit', idempotencyKey: 'fenced-edit',
      requestDigest: metadataWorkEditDigest(result.work, editResult.revision, pendingTitle) });
    await access.claim(pendingEdit.id, pendingEdit.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, editScope, '0')).toEqual({
      scope: editScope, authorityEpoch: '1', status: 'complete', pending: 0,
    });
    const cancelledEdit = await edit('fenced-edit', { ...editBody,
      expectedHead: editResult.revision, title: pendingTitle });
    expect(cancelledEdit.status).toBe(404);
    const newlyDenied = await edit('after-edit-fence', { ...editBody,
      expectedHead: editResult.revision, title: 'Must not commit' });
    expect(newlyDenied.status).toBe(403);
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('space:create:root')");
    const spaceBody = { profile: 'space-realm-v1', name: 'Reading Realm A',
      capabilities: ['realm'], actingSubject: actor } as const;
    const createSpace = (key: string, value: { profile: 'space-realm-v1'; name: string;
      capabilities: readonly ['realm']; actingSubject: string } = spaceBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/spaces`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' }, body: JSON.stringify(value) });
    expect((await createSpace('denied-space')).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'space.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'space:create:root', 'space.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor]);
    const firstSpaceResponse = await createSpace('realm-a');
    expect(firstSpaceResponse.status).toBe(201);
    const firstSpace = await firstSpaceResponse.json() as {
      space: string; realm: string; spaceRevision: string; realmRevision: string;
      sourcePosition: { sequence: string }; replayed: boolean };
    expect(firstSpace.realm).not.toBe(firstSpace.space);
    expect(firstSpace.replayed).toBe(false);
    expect((await createSpace('realm-a')).status).toBe(200);
    expect((await createSpace('realm-a', { ...spaceBody, name: 'Changed name' })).status).toBe(409);
    const firstSpaceRead = await fetch(`http://127.0.0.1:${mainPort}/v1/spaces/${
      firstSpace.space.split('/').at(-1)}`);
    expect(firstSpaceRead.status).toBe(200);
    expect(await firstSpaceRead.json()).toMatchObject({ space: firstSpace.space,
      realm: firstSpace.realm, name: spaceBody.name, owner: actor,
      capabilities: ['realm'], state: 'active' });
    const secondSpaceBody = { ...spaceBody, name: 'Reading Realm B' };
    const secondSpaceResponse = await createSpace('realm-b', secondSpaceBody);
    expect(secondSpaceResponse.status).toBe(201);
    const secondSpace = await secondSpaceResponse.json() as {
      space: string; realm: string; sourcePosition: { sequence: string } };
    expect(secondSpace.realm).not.toBe(firstSpace.realm);
    expect(secondSpace.space).not.toBe(firstSpace.space);
    expect((await createSpace('invalid-capabilities',
      { ...spaceBody, capabilities: ['zone'] as unknown as ['realm'] })).status).toBe(400);
    const pendingSpaceInput = { name: 'Uncommitted Realm', actingSubject: actor };
    const pendingSpace = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: 'space:create:root',
    action: 'space.create', idempotencyKey: 'pending-space',
    requestDigest: spaceCreationDigest(pendingSpaceInput) });
    await access.claim(pendingSpace.id, pendingSpace.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, 'space:create:root', '0'))
      .toEqual({ scope: 'space:create:root', authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readSpaceCreationReceipt(environment, pendingSpace.id))?.outcome).toBe('cancelled');
    expect((await createSpace('pending-space', { ...spaceBody, name: pendingSpaceInput.name })).status)
      .toBe(409);
    expect((await createSpace('after-space-fence')).status).toBe(403);
    for (let index = 0; index < 8; index++) {
      const batch = await relayMainOutboxOnce(fuseki, pool, 'contribution-proof');
      if (!batch) break;
      if (batch.sequence === secondSpace.sourcePosition.sequence) break;
    }
    const spaceEvent = await pool.query<{ envelope: { type: string; data: { receipt: {
      space: string; realm: string; spaceManifest: string; realmManifest: string } } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
    [lineage.dataEpoch, firstSpace.sourcePosition.sequence]);
    expect(spaceEvent.rows[0]?.envelope).toMatchObject({ type: 'com.rezics.space.created.v1',
      data: { receipt: { space: firstSpace.space, realm: firstSpace.realm,
        spaceManifest: expect.stringMatching(/^urn:rezics:sha256:/),
        realmManifest: expect.stringMatching(/^urn:rezics:sha256:/) } } });
    expect(JSON.stringify(spaceEvent.rows[0]?.envelope)).not.toContain(spaceBody.name);
    const contextRead = (realm: string) => fetch(`http://127.0.0.1:${mainPort}/v1/realms/${
      realm.split('/').at(-1)}/classification-context`);
    expect((await contextRead(firstSpace.realm)).status).toBe(404);
    const contextScopeA = `classification:context:${firstSpace.realm}`;
    const contextScopeB = `classification:context:${secondSpace.realm}`;
    for (const scope of [contextScopeA, contextScopeB]) {
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    const createContext = (key: string, realm: string) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/classification-contexts`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'classification-context-v1', realm,
          actingSubject: actor }),
      });
    expect((await createContext('denied-classification-context', firstSpace.realm)).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'classification.context.configure', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    for (const scope of [contextScopeA, contextScopeB]) {
      await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'classification.context.configure', now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), actor, scope]);
    }
    const contextARace = await Promise.all([
      createContext('classification-context-a-1', firstSpace.realm),
      createContext('classification-context-a-2', firstSpace.realm),
    ]);
    expect(contextARace.map(response => response.status).sort()).toEqual([201, 409]);
    const contextAKey = `classification-context-a-${contextARace.findIndex(
      response => response.status === 201) + 1}`;
    const contextAResponse = contextARace.find(response => response.status === 201)!;
    const contextA = await contextAResponse.json() as { context: string; contextRevision: string;
      sourcePosition: { sequence: string } };
    const contextBResponse = await createContext('classification-context-b', secondSpace.realm);
    expect(contextBResponse.status).toBe(201);
    const contextB = await contextBResponse.json() as { context: string; contextRevision: string;
      sourcePosition: { sequence: string } };
    expect(contextA.context).not.toBe(firstSpace.realm);
    expect(contextB.context).not.toBe(secondSpace.realm);
    expect(contextB.context).not.toBe(contextA.context);
    expect((await createContext(contextAKey, firstSpace.realm)).status).toBe(200);
    expect(await (await contextRead(firstSpace.realm)).json()).toMatchObject({
      realm: firstSpace.realm, context: contextA.context,
      contextRevision: contextA.contextRevision, role: 'realm-classification',
      fallbackContext: 'urn:rezics:classification-context:global',
      inheritancePolicy: 'https://rezics.com/definition/classification-inherit-global-v1',
    });
    expect(await (await contextRead(secondSpace.realm)).json()).toMatchObject({
      realm: secondSpace.realm, context: contextB.context });
    const pendingContextInput = { realm: secondSpace.realm, actingSubject: actor };
    const pendingContext = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: contextScopeB,
    action: 'classification.context.configure', idempotencyKey: 'pending-classification-context',
    requestDigest: classificationContextDigest(pendingContextInput) });
    await access.claim(pendingContext.id, pendingContext.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, contextScopeB, '0'))
      .toEqual({ scope: contextScopeB, authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readClassificationContextReceipt(environment, pendingContext.id))?.outcome)
      .toBe('cancelled');
    expect((await createContext('pending-classification-context', secondSpace.realm)).status)
      .toBe(409);
    for (let index = 0; index < 6; index++) {
      const batch = await relayMainOutboxOnce(fuseki, pool, 'contribution-proof');
      if (!batch || batch.sequence === contextB.sourcePosition.sequence) break;
    }
    const contextEvent = await pool.query<{ envelope: { type: string; data: { receipt: {
      classificationContext: string; contextManifest: string } } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, contextA.sourcePosition.sequence]);
    expect(contextEvent.rows[0]?.envelope).toMatchObject({
      type: 'com.rezics.classification.context-created.v1',
      data: { receipt: { classificationContext: contextA.context,
        contextManifest: expect.stringMatching(/^urn:rezics:sha256:/) } },
    });
    const propositionScope = 'classification:define:global';
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [propositionScope]);
    const propositionBody = { profile: 'classification-proposition-v1',
      label: 'Science fiction', actingSubject: actor };
    const define = (key: string, body = propositionBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/classification-propositions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await define('denied-classification-proposition')).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'classification.proposition.define', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'classification.proposition.define', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, propositionScope]);
    const definedResponse = await define('classification-proposition-a');
    expect(definedResponse.status).toBe(201);
    const defined = await definedResponse.json() as {
      scheme: string; concept: string; path: string; expression: string; sense: string;
      definitionRevision: string; sourcePosition: { sequence: string }; replayed: boolean };
    expect(new Set([defined.scheme, defined.concept, defined.path,
      defined.expression, defined.sense]).size).toBe(5);
    expect(defined.replayed).toBe(false);
    expect((await define('classification-proposition-a')).status).toBe(200);
    expect((await define('classification-proposition-a',
      { ...propositionBody, label: 'Fantasy' })).status).toBe(409);
    const readProposition = () => fetch(`http://127.0.0.1:${mainPort}/v1/classification-propositions/${
      defined.sense.split('/').at(-1)}`);
    expect(await (await readProposition()).json()).toMatchObject({
      scheme: defined.scheme, concept: defined.concept, path: defined.path,
      expression: defined.expression, sense: defined.sense,
      definitionRevision: defined.definitionRevision, label: propositionBody.label,
      interpretationScope: 'urn:rezics:classification-context:global',
    });
    const pendingPropositionInput = { label: 'Uncommitted concept', actingSubject: actor };
    const pendingProposition = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: propositionScope,
    action: 'classification.proposition.define', idempotencyKey: 'pending-classification-proposition',
    requestDigest: classificationPropositionDigest(pendingPropositionInput) });
    await access.claim(pendingProposition.id, pendingProposition.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, propositionScope, '0'))
      .toEqual({ scope: propositionScope, authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readClassificationPropositionReceipt(environment, pendingProposition.id))?.outcome)
      .toBe('cancelled');
    expect((await define('pending-classification-proposition',
      { ...propositionBody, label: pendingPropositionInput.label })).status).toBe(409);
    for (let index = 0; index < 8; index++) {
      const batch = await relayMainOutboxOnce(fuseki, pool, 'contribution-proof');
      if (!batch) break;
      if (batch.sequence === defined.sourcePosition.sequence) break;
    }
    const propositionEvent = await pool.query<{ envelope: { type: string; data: { receipt: {
      sense: string; definitionManifest: string } } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, defined.sourcePosition.sequence]);
    expect(propositionEvent.rows[0]?.envelope).toMatchObject({
      type: 'com.rezics.classification.proposition-defined.v1',
      data: { receipt: { sense: defined.sense,
        definitionManifest: expect.stringMatching(/^urn:rezics:sha256:/) } },
    });
    expect(JSON.stringify(propositionEvent.rows[0]?.envelope)).not.toContain(propositionBody.label);
    const decisionScopes = ['classification:decide:global',
      `classification:decide:${firstSpace.realm}`,
      `classification:decide:${secondSpace.realm}`];
    for (const scope of decisionScopes) {
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    const decisionBody = { profile: 'classification-direct-decision-v1',
      context: { kind: 'global' }, work: result.work, mainVersion: result.mainVersion,
      sense: defined.sense, expectedDecisionHead: null,
      outcome: 'accepted', actingSubject: actor } as const;
    const decide = (key: string, body: Record<string, unknown> = decisionBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/classification-decisions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' }, body: JSON.stringify(body) });
    const resolveTag = (context: { kind: 'global' } | { kind: 'realm-classification'; id: string }) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/classification-resolutions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'classification-resolution-v1',
          context, work: result.work, mainVersion: result.mainVersion, sense: defined.sense }),
      });
    const classifiedQuery = (context: 'main' | string, sense = defined.sense) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/queries`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(context === 'main'
          ? { profile: 'public-main-classified-phrase-v1',
            phrase: 'Concurrent', language: null, sense }
          : { profile: 'public-realm-classified-phrase-v1',
            context: { kind: 'realm-local', id: context },
            phrase: 'Concurrent', language: null, sense }),
      });
    expect(await (await resolveTag({ kind: 'global' })).json()).toMatchObject({
      state: 'absent', source: 'none', decision: null });
    expect(await (await classifiedQuery('main')).json()).toMatchObject({
      complete: true, population: 1, total: 0 });
    expect((await decide('denied-classification-decision')).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'classification.decision.set', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    for (const scope of decisionScopes) {
      await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'classification.decision.set', now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), actor, scope]);
    }
    const globalDecisionResponse = await decide('classification-global-accepted');
    expect(globalDecisionResponse.status).toBe(201);
    const globalDecision = await globalDecisionResponse.json() as { application: string;
      decision: string; sourcePosition: { sequence: string } };
    expect((await decide('classification-global-accepted')).status).toBe(200);
    expect((await decide('classification-global-accepted',
      { ...decisionBody, outcome: 'rejected' })).status).toBe(409);
    expect(await (await resolveTag({ kind: 'global' })).json()).toMatchObject({
      state: 'accepted', source: 'global', application: globalDecision.application,
      decision: globalDecision.decision });
    expect(await (await classifiedQuery('main')).json()).toMatchObject({
      complete: true, population: 1, total: 1,
      results: [{ classification: { sense: defined.sense,
        decision: globalDecision.decision, source: 'global' } }] });
    const realmAClassification = { ...decisionBody,
      context: { kind: 'realm-classification' as const, id: firstSpace.realm },
      outcome: 'rejected' };
    const realmBClassification = { ...decisionBody,
      context: { kind: 'realm-classification' as const, id: secondSpace.realm } };
    expect(await (await resolveTag(realmAClassification.context)).json()).toMatchObject({
      state: 'accepted', source: 'inherited-global', decision: globalDecision.decision });
    expect(await (await classifiedQuery(firstSpace.realm)).json()).toMatchObject({
      complete: true, population: 1, total: 1,
      results: [{ classification: { decision: globalDecision.decision,
        source: 'inherited-global' } }] });
    const realmADecisionResponse = await decide('classification-realm-a-rejected', realmAClassification);
    expect(realmADecisionResponse.status).toBe(201);
    const realmADecision = await realmADecisionResponse.json() as { application: string;
      decision: string; sourcePosition: { sequence: string } };
    expect(await (await resolveTag(realmAClassification.context)).json()).toMatchObject({
      state: 'rejected', source: 'local', application: realmADecision.application,
      decision: realmADecision.decision });
    expect(await (await classifiedQuery(firstSpace.realm)).json()).toMatchObject({
      complete: true, population: 1, total: 0 });
    expect(await (await resolveTag(realmBClassification.context)).json()).toMatchObject({
      state: 'accepted', source: 'inherited-global', decision: globalDecision.decision });
    const realmBDecisionResponse = await decide('classification-realm-b-accepted', realmBClassification);
    expect(realmBDecisionResponse.status).toBe(201);
    const realmBDecision = await realmBDecisionResponse.json() as { application: string;
      decision: string; sourcePosition: { sequence: string } };
    expect(realmBDecision.application).not.toBe(realmADecision.application);
    expect(await (await resolveTag(realmBClassification.context)).json()).toMatchObject({
      state: 'accepted', source: 'local', decision: realmBDecision.decision });
    expect(await (await classifiedQuery(secondSpace.realm)).json()).toMatchObject({
      complete: true, population: 1, total: 1,
      results: [{ classification: { decision: realmBDecision.decision,
        source: 'local' } }] });
    expect((await classifiedQuery('main', `https://rezics.com/id/${Bun.randomUUIDv7()}`)).status)
      .toBe(503);
    const revisedRealmA = { ...realmAClassification,
      expectedDecisionHead: realmADecision.decision, outcome: 'accepted' };
    const revisedResponse = await decide('classification-realm-a-revised', revisedRealmA);
    expect(revisedResponse.status).toBe(201);
    const revised = await revisedResponse.json() as { application: string; decision: string;
      sourcePosition: { sequence: string } };
    expect(revised.application).toBe(realmADecision.application);
    expect(revised.decision).not.toBe(realmADecision.decision);
    expect((await decide('classification-realm-a-stale', revisedRealmA)).status).toBe(409);
    expect(await (await resolveTag(realmAClassification.context)).json()).toMatchObject({
      state: 'accepted', source: 'local', decision: revised.decision });
    const finalRealmA = { ...realmAClassification, expectedDecisionHead: revised.decision };
    const finalRealmAResponse = await decide('classification-realm-a-final-rejection', finalRealmA);
    expect(finalRealmAResponse.status).toBe(201);
    const finalRealmADecision = await finalRealmAResponse.json() as { decision: string };
    expect(await (await resolveTag(realmAClassification.context)).json()).toMatchObject({
      state: 'rejected', source: 'local', decision: finalRealmADecision.decision });
    expect(await (await resolveTag(realmBClassification.context)).json()).toMatchObject({
      state: 'accepted', source: 'local', decision: realmBDecision.decision });
    const pendingDecisionInput = { ...decisionBody, outcome: 'rejected' as const };
    const pendingDecision = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: decisionScopes[0]!,
    action: 'classification.decision.set', idempotencyKey: 'pending-classification-decision',
    requestDigest: classificationDecisionDigest(pendingDecisionInput) });
    await access.claim(pendingDecision.id, pendingDecision.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, decisionScopes[0]!, '0'))
      .toEqual({ scope: decisionScopes[0], authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readClassificationDecisionReceipt(environment, pendingDecision.id))?.outcome)
      .toBe('cancelled');
    expect((await decide('pending-classification-decision', pendingDecisionInput)).status).toBe(409);
    for (let index = 0; index < 12; index++) {
      const batch = await relayMainOutboxOnce(fuseki, pool, 'contribution-proof');
      if (!batch || batch.sequence === revised.sourcePosition.sequence) break;
    }
    const decisionEvent = await pool.query<{ envelope: { type: string; data: { receipt: {
      application: string; decision: string; decisionManifest: string;
      decisionOutcome: string } } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, realmADecision.sourcePosition.sequence]);
    expect(decisionEvent.rows[0]?.envelope).toMatchObject({
      type: 'com.rezics.classification.decision-changed.v1',
      data: { receipt: { application: realmADecision.application,
        decision: realmADecision.decision, decisionOutcome: 'rejected',
        decisionManifest: expect.stringMatching(/^urn:rezics:sha256:/) } },
    });
    const ratingScopes = [`rating:context:${firstSpace.realm}`,
      `rating:context:${secondSpace.realm}`];
    for (const scope of ratingScopes) {
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    const ratingBody = { profile: 'realm-standing-rating-context-v1',
      realm: firstSpace.realm, question: 'Overall quality', actingSubject: actor } as const;
    const createRating = (key: string, body: Record<string, unknown> = ratingBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/rating-contexts`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`,
          'idempotency-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body) });
    expect((await createRating('denied-rating-context')).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'rating.context.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    for (const scope of ratingScopes) {
      await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'rating.context.create', now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), actor, scope]);
    }
    const ratingAResponse = await createRating('rating-a-quality');
    expect(ratingAResponse.status).toBe(201);
    const ratingA = await ratingAResponse.json() as { context: string;
      contextRevision: string; sourcePosition: { sequence: string } };
    expect((await createRating('rating-a-quality')).status).toBe(200);
    expect((await createRating('rating-a-quality',
      { ...ratingBody, question: 'Writing quality' })).status).toBe(409);
    const ratingASecondResponse = await createRating('rating-a-writing',
      { ...ratingBody, question: 'Writing quality' });
    expect(ratingASecondResponse.status).toBe(201);
    const ratingASecond = await ratingASecondResponse.json() as { context: string };
    const ratingBResponse = await createRating('rating-b-quality',
      { ...ratingBody, realm: secondSpace.realm });
    expect(ratingBResponse.status).toBe(201);
    const ratingB = await ratingBResponse.json() as { context: string };
    expect(new Set([ratingA.context, ratingASecond.context, ratingB.context]).size).toBe(3);
    const joinedQuery = (realm: string, ratingContext: string,
      minimumMeanTimes10: number, sense = defined.sense, phrase = 'Concurrent') =>
      fetch(`http://127.0.0.1:${mainPort}/v1/queries`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'public-realm-classified-rated-phrase-v1',
          context: { kind: 'realm-local', id: realm },
          phrase, language: null, sense,
          ratingContext, minimumMeanTimes10 }),
      });
    expect(await (await joinedQuery(firstSpace.realm, ratingA.context, 10)).json())
      .toMatchObject({ complete: true, population: 1, ratingPopulation: 0, total: 0 });
    expect(await (await joinedQuery(secondSpace.realm, ratingB.context, 10)).json())
      .toMatchObject({ complete: true, population: 1, ratingPopulation: 0, total: 0 });
    expect((await joinedQuery(firstSpace.realm, ratingB.context, 10)).status).toBe(404);
    expect((await joinedQuery(secondSpace.realm, ratingB.context, 10,
      `https://rezics.com/id/${Bun.randomUUIDv7()}`)).status).toBe(404);
    const acceptedRealmAResponse = await decide('classification-realm-a-reaccepted', {
      ...realmAClassification, expectedDecisionHead: finalRealmADecision.decision,
      outcome: 'accepted' });
    expect(acceptedRealmAResponse.status).toBe(201);
    const acceptedRealmA = await acceptedRealmAResponse.json() as { decision: string };
    expect(await (await joinedQuery(firstSpace.realm, ratingA.context, 10)).json())
      .toMatchObject({ complete: true, ratingPopulation: 0, total: 0 });
    expect(await (await fetch(`http://127.0.0.1:${mainPort}/v1/rating-contexts/${
      ratingA.context.split('/').at(-1)}`)).json()).toMatchObject({
      context: ratingA.context, realm: firstSpace.realm,
      question: 'Overall quality', contextRevision: ratingA.contextRevision,
      targetGrain: 'mainVersion', scale: { min: 1, max: 10, step: 1 },
      cadence: 'standing', population: 'account-principal',
      aggregation: 'latest-per-rater-mean' });
    const pendingRatingInput = { realm: firstSpace.realm,
      question: 'Cancelled question', actingSubject: actor };
    const pendingRating = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: ratingScopes[0]!,
    action: 'rating.context.create', idempotencyKey: 'pending-rating-context',
    requestDigest: ratingContextDigest(pendingRatingInput) });
    await access.claim(pendingRating.id, pendingRating.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, ratingScopes[0]!, '0'))
      .toEqual({ scope: ratingScopes[0], authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readRatingContextReceipt(environment, pendingRating.id))?.outcome)
      .toBe('cancelled');
    expect((await createRating('pending-rating-context',
      { ...ratingBody, question: 'Cancelled question' })).status).toBe(409);
    for (let index = 0; index < 12; index++) {
      const batch = await relayMainOutboxOnce(fuseki, pool, 'contribution-proof');
      if (!batch || batch.sequence === ratingA.sourcePosition.sequence) break;
    }
    const ratingEvent = await pool.query<{ envelope: { type: string; data: { receipt: {
      ratingContext: string; ratingContextRevision: string;
      ratingContextManifest: string } } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, ratingA.sourcePosition.sequence]);
    expect(ratingEvent.rows[0]?.envelope).toMatchObject({
      type: 'com.rezics.rating.context-created.v1', data: { receipt: {
        ratingContext: ratingA.context, ratingContextRevision: ratingA.contextRevision,
        ratingContextManifest: expect.stringMatching(/^urn:rezics:sha256:/) } },
    });
    expect(JSON.stringify(ratingEvent.rows[0]?.envelope)).not.toContain('Overall quality');
    const aggregateBody = { profile: 'realm-standing-latest-mean-v1',
      context: ratingA.context, work: result.work, mainVersion: result.mainVersion };
    const aggregate = (body: Record<string, unknown> = aggregateBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/rating-aggregates`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body) });
    expect(await (await aggregate()).json()).toMatchObject({ complete: true,
      population: 0, count: 0, withdrawnCount: 0, mean: null,
      precision: { kind: 'no-data' } });
    const ratingObservationScopes = [`rating:observe:${ratingA.context}`,
      `rating:observe:${ratingASecond.context}`, `rating:observe:${ratingB.context}`];
    for (const scope of ratingObservationScopes) {
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    const observationBody = { profile: 'realm-standing-rating-observation-v1',
      context: ratingA.context, work: result.work, mainVersion: result.mainVersion,
      expectedRevisionHead: null, value: 7, actingSubject: actor };
    const observe = (key: string, body: Record<string, unknown> = observationBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/rating-observations`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`,
          'idempotency-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body) });
    expect((await observe('denied-standing-rating')).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'rating.observation.set', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    for (const scope of ratingObservationScopes) {
      await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'rating.observation.set', now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), actor, scope]);
    }
    const firstObservationResponse = await observe('rating-observation-first');
    expect(firstObservationResponse.status).toBe(201);
    const firstObservation = await firstObservationResponse.json() as {
      observation: string; observationRevision: string; sourcePosition: { sequence: string } };
    expect(await (await aggregate()).json()).toMatchObject({ population: 1,
      count: 1, withdrawnCount: 0, sum: 7, mean: 7,
      precision: { numerator: 7, denominator: 1 } });
    expect(await (await joinedQuery(firstSpace.realm, ratingA.context, 70)).json())
      .toMatchObject({ complete: true, ratingPopulation: 1, total: 1,
        results: [{ classification: { decision: acceptedRealmA.decision, source: 'local' },
          rating: { count: 1, sum: 7, mean: 7 } }] });
    expect(await (await joinedQuery(firstSpace.realm, ratingA.context, 80)).json())
      .toMatchObject({ complete: true, ratingPopulation: 1, total: 0 });
    expect((await observe('rating-observation-first')).status).toBe(200);
    expect((await observe('rating-observation-first', { ...observationBody, value: 8 })).status)
      .toBe(409);
    expect((await observe('rating-observation-stale-create', observationBody)).status).toBe(409);
    const correctionBody = { ...observationBody,
      expectedRevisionHead: firstObservation.observationRevision, value: 9 };
    const correctionResponse = await observe('rating-observation-correction', correctionBody);
    expect(correctionResponse.status).toBe(201);
    const correction = await correctionResponse.json() as { observation: string;
      observationRevision: string; sourcePosition: { sequence: string } };
    expect(correction.observation).toBe(firstObservation.observation);
    expect((await observe('rating-observation-stale-correction', correctionBody)).status).toBe(409);
    const withdrawalBody = { ...observationBody,
      expectedRevisionHead: correction.observationRevision, value: null };
    const withdrawalResponse = await observe('rating-observation-withdrawal', withdrawalBody);
    expect(withdrawalResponse.status).toBe(201);
    const withdrawal = await withdrawalResponse.json() as { observation: string;
      observationRevision: string; value: null };
    expect(withdrawal.observation).toBe(firstObservation.observation);
    expect(withdrawal.value).toBeNull();
    expect(await (await aggregate()).json()).toMatchObject({ population: 1,
      count: 0, withdrawnCount: 1, sum: 0, mean: null,
      precision: { kind: 'no-data' } });
    expect(await (await joinedQuery(firstSpace.realm, ratingA.context, 10)).json())
      .toMatchObject({ complete: true, ratingPopulation: 1, total: 0 });
    const restoredResponse = await observe('rating-observation-restoration', {
      ...observationBody, expectedRevisionHead: withdrawal.observationRevision, value: 6 });
    expect(restoredResponse.status).toBe(201);
    const restored = await restoredResponse.json() as { observation: string;
      observationRevision: string };
    expect(restored.observation).toBe(firstObservation.observation);
    const secondQuestionResponse = await observe('rating-observation-second-question', {
      ...observationBody, context: ratingASecond.context, value: 4 });
    expect(secondQuestionResponse.status).toBe(201);
    const secondQuestion = await secondQuestionResponse.json() as {
      observation: string; observationRevision: string };
    expect(secondQuestion.observation)
      .not.toBe(firstObservation.observation);
    const raceBody = { ...observationBody, context: ratingASecond.context,
      expectedRevisionHead: secondQuestion.observationRevision };
    const [raceFirst, raceSecond] = await Promise.all([
      observe('rating-observation-race-first', { ...raceBody, value: 5 }),
      observe('rating-observation-race-second', { ...raceBody, value: 6 }),
    ]);
    expect([raceFirst.status, raceSecond.status].sort()).toEqual([201, 409]);
    const secondRealmResponse = await observe('rating-observation-second-realm', {
      ...observationBody, context: ratingB.context, value: 5 });
    expect(secondRealmResponse.status).toBe(201);
    expect((await secondRealmResponse.json() as { observation: string }).observation)
      .not.toBe(firstObservation.observation);
    expect(await (await joinedQuery(secondSpace.realm, ratingB.context, 50)).json())
      .toMatchObject({ complete: true, ratingPopulation: 1, total: 1,
        results: [{ classification: { decision: realmBDecision.decision, source: 'local' },
          rating: { count: 1, sum: 5, mean: 5 } }] });
    expect(await (await joinedQuery(secondSpace.realm, ratingB.context, 60)).json())
      .toMatchObject({ complete: true, ratingPopulation: 1, total: 0 });
    const disagreeResponse = await decide('classification-realm-a-rated-rejection', {
      ...realmAClassification, expectedDecisionHead: acceptedRealmA.decision,
      outcome: 'rejected' });
    expect(disagreeResponse.status).toBe(201);
    const disagree = await disagreeResponse.json() as { decision: string };
    expect(await (await joinedQuery(firstSpace.realm, ratingA.context, 10)).json())
      .toMatchObject({ complete: true, ratingPopulation: 1, total: 0 });
    expect(await (await joinedQuery(secondSpace.realm, ratingB.context, 50)).json())
      .toMatchObject({ complete: true, ratingPopulation: 1, total: 1 });
    const alignedResponse = await decide('classification-realm-a-rated-reacceptance', {
      ...realmAClassification, expectedDecisionHead: disagree.decision,
      outcome: 'accepted' });
    expect(alignedResponse.status).toBe(201);
    const ratingReadScope = `rating:read:${ratingA.context}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [ratingReadScope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'rating.observation.read', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    const ratingReadGrant = Bun.randomUUIDv7();
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'rating.observation.read', now() + interval '1 hour')`,
    [ratingReadGrant, actor, ratingReadScope]);
    const readRatingRevision = (revision: string) => {
      const url = new URL(`http://127.0.0.1:${mainPort}/v1/rating-observations/${
        firstObservation.observation.split('/').at(-1)}/revisions/${revision.split('/').at(-1)}`);
      url.searchParams.set('context', ratingA.context);
      url.searchParams.set('mainVersion', result.mainVersion);
      url.searchParams.set('actingSubject', actor);
      return fetch(url, { headers: { authorization: `Bearer ${token}` } });
    };
    const oldRatingRead = await readRatingRevision(firstObservation.observationRevision);
    const oldRatingPayload = await oldRatingRead.json();
    expect({ status: oldRatingRead.status, body: oldRatingPayload }).toMatchObject({ status: 200 });
    expect(oldRatingPayload).toMatchObject({ observation: firstObservation.observation,
      observationRevision: firstObservation.observationRevision, value: 7,
      availability: 'available' });
    const withdrawnRead = await readRatingRevision(withdrawal.observationRevision);
    expect(withdrawnRead.status).toBe(200);
    expect(await withdrawnRead.json()).toMatchObject({ value: null,
      availability: 'withdrawn', predecessor: correction.observationRevision });
    const secondRaterSignUp = await fetch(`${accountBase}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: accountBase },
      body: JSON.stringify({ name: 'Second Rater', email: 'second-rater@example.test',
        password: 'correct horse battery staple' }) });
    expect(secondRaterSignUp.status).toBe(200);
    const secondRater = await secondRaterSignUp.json() as { user: { id: string } };
    const secondVerifier = 'c'.repeat(64);
    const secondAuthorize = new URL(`${accountBase}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: publicClient.client_id, redirect_uri: callback,
      scope: 'openid rating:submit rating:read', state: 'second-rater-state',
      code_challenge: createHash('sha256').update(secondVerifier).digest('base64url'),
      code_challenge_method: 'S256', resource })) secondAuthorize.searchParams.set(key, value);
    const secondAuthorization = await fetch(secondAuthorize, {
      headers: { cookie: secondRaterSignUp.headers.get('set-cookie')! }, redirect: 'manual' });
    expect(secondAuthorization.status).toBe(302);
    const secondCode = new URL(secondAuthorization.headers.get('location')!)
      .searchParams.get('code')!;
    const secondExchange = await fetch(`${accountBase}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code',
        client_id: publicClient.client_id, code: secondCode, redirect_uri: callback,
        code_verifier: secondVerifier, resource }) });
    expect(secondExchange.status).toBe(200);
    const secondToken = (await secondExchange.json() as { access_token: string }).access_token;
    const secondPrincipalId = Bun.randomUUIDv7();
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [secondPrincipalId, metadata.issuer, secondRater.user.id]);
    for (const action of ['rating.observation.set', 'rating.observation.read']) {
      await pool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), secondPrincipalId, actor, action]);
    }
    const secondRaterResponse = await fetch(`http://127.0.0.1:${mainPort}/v1/rating-observations`, {
      method: 'POST', headers: { authorization: `Bearer ${secondToken}`,
        'idempotency-key': 'second-rater-same-question', 'content-type': 'application/json' },
      body: JSON.stringify({ ...observationBody, value: 3 }) });
    expect(secondRaterResponse.status).toBe(201);
    const secondRaterObservation = await secondRaterResponse.json() as {
      observation: string; observationRevision: string };
    expect(secondRaterObservation.observation).not.toBe(firstObservation.observation);
    const twoRaterAggregate = await aggregate();
    expect(twoRaterAggregate.status).toBe(200);
    const twoRaterAggregateBody = await twoRaterAggregate.json();
    expect(twoRaterAggregateBody).toMatchObject({ population: 2,
      count: 2, withdrawnCount: 0, sum: 9, mean: 4.5,
      precision: { numerator: 9, denominator: 2 },
      histogram: [0, 0, 1, 0, 0, 1, 0, 0, 0, 0] });
    const joinedTwoRater = await joinedQuery(firstSpace.realm, ratingA.context, 45);
    expect(joinedTwoRater.status).toBe(200);
    expect(await joinedTwoRater.json()).toMatchObject({
      complete: true, ratingPopulation: 2, total: 1,
      sourcePosition: twoRaterAggregateBody.sourcePosition,
      results: [{ rating: { count: 2, sum: 9, mean: 4.5,
        precision: { numerator: 9, denominator: 2 } } }] });
    expect(await (await joinedQuery(firstSpace.realm, ratingA.context, 46)).json())
      .toMatchObject({ complete: true, ratingPopulation: 2, total: 0 });
    const secondOwnUrl = new URL(`http://127.0.0.1:${mainPort}/v1/rating-observations/${
      secondRaterObservation.observation.split('/').at(-1)}/revisions/${
      secondRaterObservation.observationRevision.split('/').at(-1)}`);
    secondOwnUrl.searchParams.set('context', ratingA.context);
    secondOwnUrl.searchParams.set('mainVersion', result.mainVersion);
    secondOwnUrl.searchParams.set('actingSubject', actor);
    expect((await fetch(secondOwnUrl, { headers: { authorization: `Bearer ${secondToken}` } })).status)
      .toBe(200);
    const firstRaterUrl = new URL(`http://127.0.0.1:${mainPort}/v1/rating-observations/${
      firstObservation.observation.split('/').at(-1)}/revisions/${
      firstObservation.observationRevision.split('/').at(-1)}`);
    firstRaterUrl.searchParams.set('context', ratingA.context);
    firstRaterUrl.searchParams.set('mainVersion', result.mainVersion);
    firstRaterUrl.searchParams.set('actingSubject', actor);
    expect((await fetch(firstRaterUrl, { headers: { authorization: `Bearer ${secondToken}` } })).status)
      .toBe(404);
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [ratingReadGrant]);
    expect((await readRatingRevision(firstObservation.observationRevision)).status).toBe(403);
    const pendingObservationInput = { context: ratingA.context, work: result.work,
      mainVersion: result.mainVersion, expectedRevisionHead: restored.observationRevision,
      value: 8, actingSubject: actor };
    const pendingObservation = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: ratingObservationScopes[0]!,
    action: 'rating.observation.set', idempotencyKey: 'pending-rating-observation',
    requestDigest: standingRatingDigest(pendingObservationInput) });
    await access.claim(pendingObservation.id, pendingObservation.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, ratingObservationScopes[0]!, '0'))
      .toEqual({ scope: ratingObservationScopes[0], authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readStandingRatingReceipt(environment, pendingObservation.id))?.outcome)
      .toBe('cancelled');
    expect((await observe('pending-rating-observation', {
      ...observationBody, expectedRevisionHead: restored.observationRevision, value: 8 })).status)
      .toBe(409);
    for (let index = 0; index < 18; index++) {
      const batch = await relayMainOutboxOnce(fuseki, pool, 'contribution-proof');
      if (!batch || batch.sequence === firstObservation.sourcePosition.sequence) break;
    }
    const observationEvent = await pool.query<{ envelope: { type: string; data: { receipt: {
      ratingObservation: string; observationRevision: string;
      observationManifest: string; ratingValue: number } } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, firstObservation.sourcePosition.sequence]);
    expect(observationEvent.rows[0]?.envelope).toMatchObject({
      type: 'com.rezics.rating.observation-changed.v1', data: { receipt: {
        ratingObservation: firstObservation.observation,
        observationRevision: firstObservation.observationRevision,
        observationManifest: expect.stringMatching(/^urn:rezics:sha256:/),
        ratingValue: 7 } },
    });
    expect(JSON.stringify(observationEvent.rows[0]?.envelope)).not.toContain(principalId);
    const realmRead = (realm: string) => fetch(`http://127.0.0.1:${mainPort}/v1/realms/${
      realm.split('/').at(-1)}/main-versions/${mainId}/selection`);
    const realmQuery = (realm: string, phrase: string, language: string | null = null) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/queries`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'public-realm-phrase-v1',
          context: { kind: 'realm-local', id: realm }, phrase, language }) });
    expect(await (await realmRead(firstSpace.realm)).json()).toMatchObject({
      reason: 'main-fallback', effectiveContext: result.mainVersion,
      selection: replacement.selection, body: winningText });
    expect(await (await realmQuery(firstSpace.realm, 'Concurrent')).json()).toMatchObject({
      complete: true, population: 1, total: 1,
      results: [{ matchUnit: replacement.matchUnit, reason: 'main-fallback' }] });
    const realmAScope = `publication:adopt:${firstSpace.realm}`;
    const realmBScope = `publication:adopt:${secondSpace.realm}`;
    for (const scope of [realmAScope, realmBScope]) {
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    const realmABody = { profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: firstSpace.realm },
      work: result.work, mainVersion: result.mainVersion,
      contribution: contributionResult.contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
      actingSubject: actor } as const;
    const adopt = (key: string, value: SelectRealmLocalInput & {
      profile: 'realm-local-selection-v1' } = realmABody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/publication-selections`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' }, body: JSON.stringify(value) });
    expect((await adopt('denied-realm-adoption')).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'publication.adopt', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    for (const scope of [realmAScope, realmBScope]) {
      await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'publication.adopt', now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), actor, scope]);
    }
    const realmAResponse = await adopt('realm-a-adoption');
    expect(realmAResponse.status).toBe(201);
    const realmA = await realmAResponse.json() as { selection: string; matchUnit: string;
      sourcePosition: { sequence: string } };
    expect((await adopt('realm-a-adoption')).status).toBe(200);
    expect(await (await realmRead(firstSpace.realm)).json()).toMatchObject({
      reason: 'realm-adoption', effectiveContext: firstSpace.realm,
      selection: realmA.selection, body: winningText });
    const realmBBody = { ...realmABody, context: { kind: 'realm-local' as const,
      id: secondSpace.realm }, contribution: alternativeDraft.contribution,
      publicationDecision: alternativePublication.publicationDecision };
    const realmBResponse = await adopt('realm-b-adoption', realmBBody);
    expect(realmBResponse.status).toBe(201);
    const realmB = await realmBResponse.json() as { selection: string; matchUnit: string;
      sourcePosition: { sequence: string } };
    expect(realmB.selection).not.toBe(realmA.selection);
    expect(await (await realmRead(secondSpace.realm)).json()).toMatchObject({
      reason: 'realm-adoption', effectiveContext: secondSpace.realm,
      selection: realmB.selection, body: alternativeText });
    expect(await (await realmQuery(firstSpace.realm, 'Concurrent')).json()).toMatchObject({
      complete: true, population: 3, total: 1,
      results: [{ matchUnit: realmA.matchUnit, reason: 'realm-adoption' }] });
    expect(await (await realmQuery(firstSpace.realm, 'Alternative Realm B')).json()).toMatchObject({
      complete: true, population: 3, total: 0 });
    expect(await (await realmQuery(secondSpace.realm, 'Alternative Realm B')).json()).toMatchObject({
      complete: true, population: 3, total: 1,
      results: [{ matchUnit: realmB.matchUnit, reason: 'realm-adoption' }] });
    expect(await (await realmQuery(secondSpace.realm, 'Concurrent')).json()).toMatchObject({
      complete: true, population: 3, total: 0 });
    expect(await (await joinedQuery(firstSpace.realm, ratingA.context, 45)).json())
      .toMatchObject({ complete: true, population: 3, ratingPopulation: 2, total: 1,
        results: [{ matchUnit: realmA.matchUnit, reason: 'realm-adoption' }] });
    expect(await (await joinedQuery(secondSpace.realm, ratingB.context, 50,
      defined.sense, 'Alternative Realm B')).json())
      .toMatchObject({ complete: true, population: 3, ratingPopulation: 1, total: 1,
        results: [{ matchUnit: realmB.matchUnit, reason: 'realm-adoption' }] });
    expect(await (await joinedQuery(secondSpace.realm, ratingB.context, 50)).json())
      .toMatchObject({ complete: true, population: 3, total: 0 });
    expect(await (await publicSelectionRead()).json()).toMatchObject({
      selection: replacement.selection, body: winningText });
    expect(await (await publicQuery('Concurrent')).json()).toMatchObject({
      complete: true, population: 3, total: 1,
      results: [{ matchUnit: replacement.matchUnit }] });
    expect(await (await publicQuery('Alternative Realm B')).json()).toMatchObject({
      complete: true, population: 3, total: 0 });
    expect((await adopt('stale-realm-adoption')).status).toBe(409);
    const realmAReplacement = { ...realmABody, expectedSelectionHead: realmA.selection };
    const realmARace = await Promise.all([
      adopt('realm-a-replace-1', realmAReplacement),
      adopt('realm-a-replace-2', realmAReplacement),
    ]);
    expect(realmARace.map(response => response.status).sort()).toEqual([201, 409]);
    const realmAWinner = (await realmARace.find(response => response.status === 201)!.json()) as {
      selection: string; matchUnit: string };
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:search:public> {
      <${realmA.matchUnit}> ?p ?o } }`)).boolean).toBe(false);
    expect((await fuseki.query(`ASK { GRAPH <urn:rezics:search:public> {
      <${realmB.matchUnit}> a <https://rezics.com/vocab/MatchUnit> } }`)).boolean).toBe(true);
    expect(await (await realmRead(secondSpace.realm)).json()).toMatchObject({
      selection: realmB.selection, body: alternativeText });
    expect(await (await realmQuery(firstSpace.realm, 'Concurrent')).json()).toMatchObject({
      complete: true, population: 3, total: 1,
      results: [{ matchUnit: realmAWinner.matchUnit, reason: 'realm-adoption' }] });
    const realmBudgetUnits = Array.from({ length: 98 }, () =>
      `https://rezics.com/id/${Bun.randomUUIDv7()}`);
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:search:public> {
        ${realmBudgetUnits.map((unit, index) => `<${unit}> a rv:MatchUnit ;
          rv:searchBody "Realm budget filler ${index}"@en .`).join('\n')}
      }
    }`);
    const exhaustedRealm = await realmQuery(firstSpace.realm, 'Concurrent');
    expect(exhaustedRealm.status).toBe(422);
    expect(await exhaustedRealm.json()).toMatchObject({ code: 'query_budget_exceeded' });
    const exhaustedJoined = await joinedQuery(firstSpace.realm, ratingA.context, 45);
    expect(exhaustedJoined.status).toBe(422);
    expect(await exhaustedJoined.json()).toMatchObject({ code: 'query_budget_exceeded' });
    await fuseki.update(`DELETE { GRAPH <urn:rezics:search:public> { ?unit ?p ?o } }
      WHERE { VALUES ?unit { ${realmBudgetUnits.map(unit => `<${unit}>`).join(' ')} }
        GRAPH <urn:rezics:search:public> { ?unit ?p ?o } }`);
    const ratingBudgetSlots = Array.from({ length: 99 }, () =>
      `https://rezics.com/id/${Bun.randomUUIDv7()}`);
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:current> {
        ${ratingBudgetSlots.map(observation => `<${observation}> a rv:RatingObservation ;
          rv:ratingContext <${ratingA.context}> .`).join('\n')}
      }
    }`);
    const exhaustedRatings = await joinedQuery(firstSpace.realm, ratingA.context, 45);
    expect(exhaustedRatings.status).toBe(422);
    expect(await exhaustedRatings.json()).toMatchObject({ code: 'query_budget_exceeded' });
    await fuseki.update(`DELETE { GRAPH <urn:rezics:graph:current> { ?observation ?p ?o } }
      WHERE { VALUES ?observation { ${ratingBudgetSlots.map(id => `<${id}>`).join(' ')} }
        GRAPH <urn:rezics:graph:current> { ?observation ?p ?o } }`);
    const malformedObservation = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:current> {
        <${malformedObservation}> a rv:RatingObservation ;
          rv:ratingContext <${ratingA.context}> .
      }
    }`);
    const malformedJoined = await joinedQuery(firstSpace.realm, ratingA.context, 45);
    expect(malformedJoined.status).toBe(503);
    expect(await malformedJoined.json()).toMatchObject({ code: 'query_unavailable' });
    await fuseki.update(`DELETE WHERE { GRAPH <urn:rezics:graph:current> {
      <${malformedObservation}> ?p ?o } }`);
    expect(await (await joinedQuery(firstSpace.realm, ratingA.context, 45)).json())
      .toMatchObject({ complete: true, ratingPopulation: 2, total: 1 });
    const realmASuppressionScope = `publication:reject:${firstSpace.realm}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [realmASuppressionScope]);
    const rejectionBody = { profile: 'realm-local-rejection-v1' as const,
      context: { kind: 'realm-local' as const, id: firstSpace.realm },
      work: result.work, mainVersion: result.mainVersion,
      expectedSelectionHead: realmAWinner.selection,
      decisionBasis: 'realm-manager-review' as const,
      reasonCode: 'not-approved' as const, actingSubject: actor };
    const rejectRealm = (key: string, value: RejectRealmLocalInput & {
      profile: 'realm-local-rejection-v1' } = rejectionBody) =>
      fetch(`http://127.0.0.1:${mainPort}/v1/publication-rejections`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          'content-type': 'application/json' }, body: JSON.stringify(value) });
    expect((await rejectRealm('denied-realm-rejection')).status).toBe(403);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'publication.reject', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'publication.reject', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actor, realmASuppressionScope]);
    const rejectionResponse = await rejectRealm('realm-a-rejection');
    expect(rejectionResponse.status).toBe(201);
    const rejection = await rejectionResponse.json() as { rejection: string;
      sourcePosition: { sequence: string } };
    expect((await rejectRealm('realm-a-rejection')).status).toBe(200);
    expect((await rejectRealm('stale-realm-rejection',
      { ...rejectionBody, expectedSelectionHead: realmAWinner.selection })).status).toBe(409);
    const suppressedRealmRead = await (await realmRead(firstSpace.realm)).json();
    expect(suppressedRealmRead).toMatchObject({
      status: 'suppressed', reason: 'realm-rejection', rejection: rejection.rejection,
      reasonCode: 'not-approved' });
    expect('body' in suppressedRealmRead).toBe(false);
    expect(await (await realmQuery(firstSpace.realm, 'Concurrent')).json()).toMatchObject({
      complete: true, population: 2, total: 0 });
    expect(await (await publicQuery('Concurrent')).json()).toMatchObject({
      complete: true, population: 2, total: 1 });
    expect(await (await realmRead(secondSpace.realm)).json()).toMatchObject({
      selection: realmB.selection, body: alternativeText });
    const readoptResponse = await adopt('realm-a-after-rejection',
      { ...realmABody, expectedSelectionHead: rejection.rejection });
    expect(readoptResponse.status).toBe(201);
    const readopt = await readoptResponse.json() as { selection: string; matchUnit: string };
    expect(await (await realmRead(firstSpace.realm)).json()).toMatchObject({
      reason: 'realm-adoption', selection: readopt.selection, body: winningText });
    expect(await (await realmQuery(firstSpace.realm, 'Concurrent')).json()).toMatchObject({
      complete: true, population: 3, total: 1,
      results: [{ matchUnit: readopt.matchUnit }] });
    const pendingRejectionInput = { ...rejectionBody,
      expectedSelectionHead: readopt.selection };
    const pendingRejection = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: realmASuppressionScope,
      action: 'publication.reject', idempotencyKey: 'pending-realm-rejection',
      requestDigest: realmRejectionDigest(pendingRejectionInput) });
    await access.claim(pendingRejection.id, pendingRejection.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, realmASuppressionScope, '0'))
      .toEqual({ scope: realmASuppressionScope, authorityEpoch: '1',
        status: 'complete', pending: 0 });
    expect((await readRealmRejectionReceipt(environment, pendingRejection.id))?.outcome)
      .toBe('cancelled');
    expect((await rejectRealm('pending-realm-rejection', pendingRejectionInput)).status).toBe(404);
    expect((await rejectRealm('after-realm-rejection-fence', pendingRejectionInput)).status)
      .toBe(403);
    for (let index = 0; index < 25; index++) {
      const batch = await relayMainOutboxOnce(fuseki, pool, 'contribution-proof');
      if (!batch || batch.sequence === rejection.sourcePosition.sequence) break;
    }
    const rejectionEvent = await pool.query<{ envelope: { type: string; data: {
      receipt: { rejection: string; rejectionManifest: string } } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
    [lineage.dataEpoch, rejection.sourcePosition.sequence]);
    expect(rejectionEvent.rows[0]?.envelope).toMatchObject({
      type: 'com.rezics.realm.publication-suppressed.v1', data: { receipt: {
        rejection: rejection.rejection,
        rejectionManifest: expect.stringMatching(/^urn:rezics:sha256:/) } } });
    const pendingRealmInput = { ...realmABody, expectedSelectionHead: readopt.selection };
    const pendingRealm = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: realmAScope,
      action: 'publication.adopt', idempotencyKey: 'pending-realm-adoption',
      requestDigest: realmSelectionDigest(pendingRealmInput) });
    await access.claim(pendingRealm.id, pendingRealm.requestDigest);
    expect(await strongRevokeWorkScope(environment, access, realmAScope, '0'))
      .toEqual({ scope: realmAScope, authorityEpoch: '1', status: 'complete', pending: 0 });
    expect((await readRealmSelectionReceipt(environment, pendingRealm.id))?.outcome).toBe('cancelled');
    expect((await adopt('pending-realm-adoption', pendingRealmInput)).status).toBe(404);
    expect((await adopt('after-realm-fence', pendingRealmInput)).status).toBe(403);
    for (let index = 0; index < 15; index++) {
      const batch = await relayMainOutboxOnce(fuseki, pool, 'contribution-proof');
      if (!batch || batch.sequence === realmB.sourcePosition.sequence) break;
    }
    const realmEvent = await pool.query<{ envelope: { type: string; data: {
      receipt: { realm: string; slot: string; selectionManifest: string } } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
    [lineage.dataEpoch, realmB.sourcePosition.sequence]);
    expect(realmEvent.rows[0]?.envelope).toMatchObject({
      type: 'com.rezics.realm.selection-changed.v1', data: { receipt: {
        realm: secondSpace.realm, selectionManifest: expect.stringMatching(/^urn:rezics:sha256:/),
      } },
    });
    expect(JSON.stringify(realmEvent.rows[0]?.envelope)).not.toContain(alternativeText);
    const pendingCreate = await access.register({ principal: { issuer: metadata.issuer,
      subject: user.user.id }, actingSubject: actor, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: 'before-principal-fence',
      requestDigest: metadataWorkRequestDigest('Principal fence pending Work') });
    const deleted = await fetch(`${accountBase}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: accountBase },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    expect(deleted.status).toBe(200);
    const principalState = await pool.query<{ active: boolean; enforcement_epoch: string }>(
      'SELECT active, enforcement_epoch FROM access.principal WHERE id = $1', [principalId]);
    expect(principalState.rows[0]).toEqual({ active: false, enforcement_epoch: '1' });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM access.outbox
       WHERE kind = 'account.deletion_fenced' AND principal_id = $1`, [principalId]))
      .rows[0]?.count).toBe('1');
    expect((await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM relay.account_deletion_intent WHERE principal_id = $1',
      [principalId])).rows[0]?.count).toBe('1');
    expect((await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM relay.account_subject_deletion WHERE account_subject = $1',
      [user.user.id])).rows[0]?.count).toBe('1');
    await expect(access.claim(pendingCreate.id, pendingCreate.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect(await strongRevokeWorkPrincipal(environment, access, principalId, '1')).toEqual({
      principalId, enforcementEpoch: '1', status: 'complete', pending: 0,
    });
    expect(await access.canReadWork({ issuer: metadata.issuer, subject: user.user.id },
      actor, result.work)).toBe(false);
    expect((await pool.query('SELECT id FROM "user" WHERE id = $1', [user.user.id])).rowCount)
      .toBe(0);
    const inactive = await command(token, 'real-account-create');
    expect(inactive.status).toBe(401);
    expect((await inactive.json() as { code: string }).code).toBe('account_assertion_denied');
    expect((await read(result.workRevision)).status).toBe(401);
    const count = await pool.query<{ count: string }>('SELECT count(*) FROM access.admission');
    expect(count.rows[0]!.count).toBe('68');
  } finally {
    await mainApp?.stop();
    await accountApp?.stop();
    await pool?.end();
    if (postgresStarted) execFileSync('pg_ctl', ['-D', pgData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    fusekiProcess.kill('SIGTERM');
    if (fusekiProcess.exitCode === null) {
      await new Promise<void>(resolveExit => fusekiProcess.once('exit', () => resolveExit()));
    }
  }
}, 120_000);
