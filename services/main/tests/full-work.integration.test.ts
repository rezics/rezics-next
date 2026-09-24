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
import { readRealmSelectionReceipt, realmSelectionDigest,
  type SelectRealmLocalInput } from '../src/modules/work/select-realm.ts';
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
        grant_types: ['authorization_code'], scope: 'openid work:create work:edit work:read space:create realm:adopt', skip_consent: true, require_pkce: true },
    });
    const pkceVerifier = 'b'.repeat(64);
    const authorize = new URL(`${accountBase}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: publicClient.client_id,
      redirect_uri: callback, scope: 'openid work:create work:edit work:read space:create realm:adopt', state: 'full-work-state',
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
    await fuseki.update(`DELETE { GRAPH <urn:rezics:search:public> { ?unit ?p ?o } }
      WHERE { VALUES ?unit { ${realmBudgetUnits.map(unit => `<${unit}>`).join(' ')} }
        GRAPH <urn:rezics:search:public> { ?unit ?p ?o } }`);
    const pendingRealmInput = { ...realmABody, expectedSelectionHead: realmAWinner.selection };
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
    expect(count.rows[0]!.count).toBe('32');
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
