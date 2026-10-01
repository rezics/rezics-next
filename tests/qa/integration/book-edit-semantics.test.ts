import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { ContentCore, contentDraftIntentDigest } from '../../../services/content/src/core.ts';
import { ContentComments } from '../../../services/content/src/comments.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../../services/main/src/modules/agent/provision.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { strongRevokeWorkPrincipal, strongRevokeWorkScope }
  from '../../../services/main/src/modules/work/strong-revoke.ts';
import { DATASET, GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const scope = 'openid work:create work:edit work:read comment:create';
const language = { kind: 'tag', tag: 'en', originalTag: 'en' } as const;

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

type Stack = Awaited<ReturnType<typeof startStack>>;
let started: Promise<Stack> | undefined;
const stack = () => started ??= startStack();

/** One real Account issuer, Access registry, Content owner, Jena dataset and Main app. */
async function startStack() {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_DATABASE_URL
    || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const resource = Bun.env.ACCOUNT_MAIN_RESOURCE;
  const state = join(root, '.temp', `book-edit-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource, pool: accountPool, operatorUserIds: operators });
  const account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  const signUp = async (name: string) => {
    const email = `book-${name}-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const response = await account.handle(new Request(`${base}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ ...signupPolicyFixture, name, email, password }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string } };
    return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
  };
  const operator = await signUp('operator');
  operators.add(operator.id);
  await accountPool.query("INSERT INTO rezics_account_operator (user_id, role) VALUES ($1, 'owner') ON CONFLICT DO NOTHING", [operator.id]);
  const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
  const mainClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
    body: { client_name: 'BOOK Main verifier', scope: 'work:create',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['work:create'] } });
  const redirectUri = 'http://localhost:3000/auth/callback';
  const webClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
    body: { client_name: 'BOOK offline editor', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope, skip_consent: true, require_pkce: true } });
  await migrateContent(contentPool);
  const content = new ContentCore(contentPool);
  const comments = new ContentComments(contentPool);
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const environment = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
    routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: join(state, 'objects') };
  const access = new AccessAdmissionRegistry(accessPool);
  const main = createMainApp(fuseki, { environment,
    account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: resource, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: mainClient.client_id, clientSecret: mainClient.client_secret! }),
    access, content, contentAuthoring: content, comments });
  const graphSequence = async () => {
    const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH <${GRAPHS.control}> { <${DATASET}> rv:sequence ?sequence . } }`);
    return result.results?.bindings[0]?.sequence?.value;
  };

  /** A separate Account member, represented Agent and PKCE token per editor. */
  const member = async (name: string) => {
    const user = await signUp(name);
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, `${base}/api/auth`, user.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
    const grant = async (resourceScope: string, action: string) => {
      const client = await accessPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
          [resourceScope]);
        await client.query(`INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), principalId, actor, action]);
        await client.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), actor, resourceScope, action]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    expect(signIn.status).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: webClient.client_id, redirect_uri: redirectUri, scope,
      state: randomUUID(), resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })) authorize.searchParams.set(key, value);
    const authorized = await fetch(authorize, {
      headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code',
        client_id: webClient.client_id, code, redirect_uri: redirectUri,
        code_verifier: verifier, resource }),
    });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json() as { access_token: string }).access_token;
    const send = (path: string, body: object, key = `book-${randomUUID()}`,
      authorization: string | null = `Bearer ${token}`) => main.handle(new Request(
      `http://main.local${path}`, { method: 'POST', headers: {
        'content-type': 'application/json', 'idempotency-key': key,
        ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) }));
    const read = (path: string, query: Record<string, string> = {}) => {
      const url = new URL(`http://main.local${path}`);
      url.searchParams.set('actingSubject', actor);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      return main.handle(new Request(url.toString(), {
        headers: { authorization: `Bearer ${token}` } }));
    };
    const authorIntent = { kind: 'person' as const, displayName: 'Fixture author' };
    await createAgentGraph(environment, { id: randomUUID(), agent: actor,
      ...authorIntent, digest: agentProvisionDigest(authorIntent) });
    await grant('work:create:root', 'work.create');
    const created = await send('/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work', language: 'en',
      title: `BOOK ${name} ${randomUUID()}`, actingSubject: actor });
    expect(created.status).toBe(201);
    const work = (await created.json() as { work: string }).work;
    await grant(`work:read:${work}`, 'work.read');
    await grant(`content:draft:${work}`, 'content.draft');
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = (body: string, expectedHead: string | null) => ({
      profile: 'content-text-v1', resourceId: work, variantId, language,
      direction: 'ltr', expectedHead, body, actingSubject: actor });
    const save = async (body: string, expectedHead: string | null, key?: string) => {
      const response = await send('/v1/content-drafts', draft(body, expectedHead), key);
      if (response.status !== 201) {
        throw new Error(`content draft: HTTP ${response.status} ${await response.text()}`);
      }
      return await response.json() as { revisionId: string; predecessor: string | null;
        replayed: boolean; sourcePosition: { dataEpoch: string; sequence: string } };
    };
    /** The exact Access request digest a client can recompute from its queued command. */
    const intentDigest = (body: string, expectedHead: string | null) =>
      contentDraftIntentDigest({ variant: { id: variantId, resourceId: work, language,
        direction: 'ltr' }, expectedHead, model: 'content-shape-v1', sourceRevision: null,
      serializedJson: JSON.stringify({ body }) }, actor);
    const principal = { issuer: `${base}/api/auth`, subject: user.id };
    return { actor, principalId, principal, token, grant, send, read, work, variantId,
      draft, save, intentDigest };
  };

  const draftHead = async (variantId: string) => (await contentPool.query<{ draft_head: string }>(
    'SELECT draft_head FROM content.variant WHERE id = $1', [variantId])).rows[0]?.draft_head;
  const revisions = async (variantId: string) => (await contentPool.query<{
    id: string; predecessor: string | null; body: { body: string } }>(
    'SELECT id, predecessor, body FROM content.revision WHERE variant_id = $1', [variantId])).rows;
  const admissions = async (keys: string[]) => (await accessPool.query<{ id: string;
    idempotency_key: string; request_digest: string; state: string; graph_outcome: string | null }>(
    `SELECT id, idempotency_key, request_digest, state, graph_outcome FROM access.admission
     WHERE idempotency_key = ANY($1::text[])`, [keys])).rows;
  const draftReceipt = async (admissionId: string) => (await contentPool.query<{
    outcome: string; revision_id: string | null; request_digest: string; reason: string | null }>(
    `SELECT outcome, revision_id, request_digest, reason FROM content.receipt
     WHERE operation_id = $1`, [`content-draft:${admissionId}`])).rows;
  const stop = async () => {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
    rmSync(state, { recursive: true, force: true });
  };
  return { environment, access, content, contentPool, accessPool, member, graphSequence,
    draftHead, revisions, admissions, draftReceipt, stop };
}

afterAll(async () => { if (started) await (await started).stop(); });

test('BOOK04: a paragraph comment keeps its exact revision and selector after the paragraph is edited and removed', async () => {
  const { member, contentPool, accessPool, access } = await stack();
  const editor = await member('commenter');
  const target = `Target paragraph ${randomUUID()}`;
  const repeated = 'Repeated paragraph';
  const original = `Opening paragraph\n${target}\n${repeated}\n${repeated}\nClosing paragraph`;
  const first = await editor.save(original, null);
  const comment = (revisionId: string, exact: string, body = `Note on ${exact}`) => ({
    profile: 'content-paragraph-comment-v1', resourceId: editor.work, revisionId,
    exact, body, actingSubject: editor.actor });
  await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
    [`content:comment:${editor.work}`]);
  const deniedComment = await editor.send('/v1/content-comments', comment(first.revisionId, target));
  expect(deniedComment.status).toBe(403);
  await editor.grant(`content:comment:${editor.work}`, 'content.comment');

  // Exact whole-paragraph selectors only: substrings, duplicates and absent text are rejected.
  for (const exact of ['Target paragraph', repeated, 'Absent paragraph']) {
    const rejected = await editor.send('/v1/content-comments', comment(first.revisionId, exact));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_selector' });
  }
  const multiLine = await editor.send('/v1/content-comments',
    comment(first.revisionId, `${target}\n${repeated}`));
  expect(multiLine.status).toBe(400);

  const commentKey = `book04-comment-${randomUUID()}`;
  const createdComment = await editor.send('/v1/content-comments',
    comment(first.revisionId, target), commentKey);
  expect(createdComment.status).toBe(201);
  const anchored = await createdComment.json() as { comment: string; revisionId: string;
    byteDigest: string; target: { source: string; selector: { type: string; exact: string;
      prefix: string; suffix: string } } };
  const start = original.indexOf(target);
  const selector = { type: 'TextQuoteSelector', exact: target,
    prefix: original.slice(Math.max(0, start - 32), start),
    suffix: original.slice(start + target.length, start + target.length + 32) };
  expect(anchored).toMatchObject({ revisionId: first.revisionId,
    target: { type: 'SpecificResource',
      source: `urn:rezics:content:revision:${first.revisionId}`, selector } });

  // Edit the commented paragraph in a later head.
  const revisedParagraph = `${target} (revised)`;
  const revisedBody = original.replace(target, revisedParagraph);
  const second = await editor.save(revisedBody, first.revisionId);
  expect(second.predecessor).toBe(first.revisionId);
  const oldOnEdited = await editor.send('/v1/content-comments', comment(second.revisionId, target));
  expect(oldOnEdited.status).toBe(400);
  const secondComment = await editor.send('/v1/content-comments',
    comment(second.revisionId, revisedParagraph));
  expect(secondComment.status).toBe(201);
  const onEdited = await secondComment.json() as { comment: string };

  // Remove the paragraph entirely in the next head.
  const removedBody = `Opening paragraph\n${repeated}\n${repeated}\nClosing paragraph`;
  const third = await editor.save(removedBody, second.revisionId);
  expect(third.predecessor).toBe(second.revisionId);
  const onRemoved = await editor.send('/v1/content-comments',
    comment(third.revisionId, revisedParagraph));
  expect(onRemoved.status).toBe(400);

  // A later head that makes the quoted text ambiguous still cannot retarget the anchor.
  const fourth = await editor.save(`${target}\n${removedBody}\n${target}`, third.revisionId);
  const ambiguous = await editor.send('/v1/content-comments', comment(fourth.revisionId, target));
  expect(ambiguous.status).toBe(400);

  const readComment = (id: string) => editor.read(`/v1/content-comments/${id.split('/').at(-1)}`);
  const historical = await readComment(anchored.comment);
  expect(historical.status).toBe(200);
  expect(await historical.json()).toMatchObject({ comment: anchored.comment,
    revisionId: first.revisionId, byteDigest: anchored.byteDigest, resolvedText: target,
    target: { source: `urn:rezics:content:revision:${first.revisionId}`, selector } });
  const editedHistorical = await readComment(onEdited.comment);
  expect(editedHistorical.status).toBe(200);
  expect(await editedHistorical.json()).toMatchObject({ revisionId: second.revisionId,
    resolvedText: revisedParagraph, target: { selector: { exact: revisedParagraph } } });
  const replayed = await editor.send('/v1/content-comments', comment(first.revisionId, target),
    commentKey);
  expect(replayed.status).toBe(200);
  expect(await replayed.json()).toMatchObject({ comment: anchored.comment, replayed: true,
    revisionId: first.revisionId, target: { selector } });

  const page = async (revisionId: string) => {
    const response = await editor.read(`/v1/content-revisions/${revisionId}/comments`);
    expect(response.status).toBe(200);
    return (await response.json() as { comments: Array<{ comment: string; resolvedText: string }> })
      .comments;
  };
  expect(await page(first.revisionId)).toMatchObject([{ comment: anchored.comment,
    resolvedText: target }]);
  expect(await page(second.revisionId)).toMatchObject([{ comment: onEdited.comment,
    resolvedText: revisedParagraph }]);
  expect(await page(third.revisionId)).toEqual([]);
  expect(await page(fourth.revisionId)).toEqual([]);

  const exactOriginal = await editor.read(`/v1/content-revisions/${first.revisionId}`);
  expect(exactOriginal.status).toBe(200);
  expect(await exactOriginal.json()).toMatchObject({ reference: { revisionId: first.revisionId,
    byteDigest: anchored.byteDigest }, body: { body: original } });

  // The Content owner keeps the anchor immutable; the stored row still names the first revision.
  const commentId = anchored.comment.split('/').at(-1)!;
  await expect(contentPool.query('UPDATE content.comment SET revision_id = $2 WHERE id = $1',
    [commentId, third.revisionId])).rejects.toThrow();
  const stored = await contentPool.query<{ revision_id: string; exact: string; prefix: string;
    suffix: string }>('SELECT revision_id, exact, prefix, suffix FROM content.comment WHERE id = $1',
  [commentId]);
  expect(stored.rows).toEqual([{ revision_id: first.revisionId, exact: target,
    prefix: selector.prefix, suffix: selector.suffix }]);

  // Current Work disclosure still controls the exact historical target.
  const closed = await access.strongCloseScope(`work:read:${editor.work}`, '0');
  expect(closed.pending).toBe(0);
  expect((await readComment(anchored.comment)).status).toBe(404);
  expect((await editor.read(`/v1/content-revisions/${first.revisionId}/comments`)).status).toBe(404);
  expect((await editor.read(`/v1/content-revisions/${first.revisionId}`)).status).toBe(404);
}, 120_000);

test('BOOK05: concurrent edits from one head yield one head and an explicit conflict, never a lost update', async () => {
  const { member, draftHead, revisions, admissions, draftReceipt, graphSequence } = await stack();
  const editor = await member('concurrent');
  const baseBody = 'Chapter opening\nShared paragraph\nChapter close';
  const base = await editor.save(baseBody, null);
  const writers = ['A', 'B', 'C', 'D'].map(label => ({ label,
    key: `book05-${label}-${randomUUID()}`,
    body: `Chapter opening\nShared paragraph edited by ${label}\nChapter close` }));
  const graphBefore = await graphSequence();
  const raced = await Promise.all(writers.map(writer => editor.send('/v1/content-drafts',
    editor.draft(writer.body, base.revisionId), writer.key)));
  const statuses = raced.map(response => response.status);
  expect(statuses.filter(status => status === 201)).toHaveLength(1);
  expect(statuses.filter(status => status === 409)).toHaveLength(writers.length - 1);
  const winnerIndex = statuses.indexOf(201);
  const winner = writers[winnerIndex]!;
  const won = await raced[winnerIndex]!.json() as { revisionId: string; predecessor: string };
  expect(won.predecessor).toBe(base.revisionId);
  for (const [index, response] of raced.entries()) {
    if (index !== winnerIndex) {
      expect(await response.json()).toMatchObject({ status: 409, code: 'stale_head' });
    }
  }
  expect(await draftHead(editor.variantId)).toBe(won.revisionId);
  const afterRace = await revisions(editor.variantId);
  expect(afterRace).toHaveLength(2);
  for (const writer of writers.filter(writer => writer !== winner)) {
    expect(afterRace.some(row => row.body.body === writer.body)).toBe(false);
  }

  // Each loser holds a durable stale receipt bound to its exact intent; a retry keeps the conflict.
  const recorded = await admissions(writers.map(writer => writer.key));
  expect(recorded).toHaveLength(writers.length);
  for (const writer of writers) {
    const admission = recorded.find(row => row.idempotency_key === writer.key)!;
    expect(admission.state).toBe('sealed');
    expect(admission.request_digest).toBe(editor.intentDigest(writer.body, base.revisionId));
    const receipt = await draftReceipt(admission.id);
    expect(receipt).toHaveLength(1);
    if (writer === winner) {
      expect(admission.graph_outcome).toBe('succeeded');
      expect(receipt[0]).toMatchObject({ outcome: 'succeeded', revision_id: won.revisionId });
    } else {
      expect(admission.graph_outcome).toBe('cancelled');
      expect(receipt[0]).toMatchObject({ outcome: 'stale_head', revision_id: null });
      const retry = await editor.send('/v1/content-drafts',
        editor.draft(writer.body, base.revisionId), writer.key);
      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({ code: 'stale_head' });
    }
  }
  expect(await draftHead(editor.variantId)).toBe(won.revisionId);

  // An explicit merge is a new command on the observed head that carries both intents.
  const loser = writers.find(writer => writer !== winner)!;
  const mergedBody = `Chapter opening\nShared paragraph edited by ${winner.label}\n`
    + `Shared paragraph edited by ${loser.label}\nChapter close`;
  const merged = await editor.save(mergedBody, won.revisionId);
  expect(merged.predecessor).toBe(won.revisionId);
  const staleMerge = await editor.send('/v1/content-drafts', editor.draft(mergedBody, base.revisionId));
  expect(staleMerge.status).toBe(409);
  expect(await draftHead(editor.variantId)).toBe(merged.revisionId);
  const history = await revisions(editor.variantId);
  expect(history).toEqual(expect.arrayContaining([
    { id: base.revisionId, predecessor: null, body: { body: baseBody } },
    { id: won.revisionId, predecessor: base.revisionId, body: { body: winner.body } },
    { id: merged.revisionId, predecessor: won.revisionId, body: { body: mergedBody } },
  ]));
  expect(history).toHaveLength(3);
  for (const revision of [base.revisionId, won.revisionId, merged.revisionId]) {
    const exact = await editor.read(`/v1/content-revisions/${revision}`);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ reference: { revisionId: revision,
      predecessor: history.find(row => row.id === revision)!.predecessor } });
  }
  expect(await graphSequence()).toBe(graphBefore);

  // The graph-owned Contribution draft enforces the same single-head CAS through Main.
  await editor.grant(`contribution:create:${editor.work}`, 'contribution.create');
  const createdContribution = await editor.send('/v1/contributions', {
    profile: 'text-contribution-v1', work: editor.work, language: 'en',
    body: 'Contribution base', actingSubject: editor.actor });
  expect(createdContribution.status).toBe(201);
  const contribution = await createdContribution.json() as { contribution: string;
    draftRevision: string };
  await editor.grant(`contribution:edit:${contribution.contribution}`, 'contribution.edit');
  await editor.grant(`contribution:read:${contribution.contribution}`, 'contribution.read');
  const contributionEdit = (body: string, expectedHead: string) => ({
    profile: 'text-contribution-v1', contribution: contribution.contribution,
    expectedHead, body, actingSubject: editor.actor });
  const contributionKeys = ['A', 'B', 'C'].map(label => `book05-contribution-${label}-${randomUUID()}`);
  const contributionRace = await Promise.all(contributionKeys.map((key, index) =>
    editor.send('/v1/contribution-edits', contributionEdit(`Contribution edit ${index}`,
      contribution.draftRevision), key)));
  const contributionStatuses = contributionRace.map(response => response.status);
  expect(contributionStatuses.filter(status => status === 200)).toHaveLength(1);
  expect(contributionStatuses.filter(status => status === 409)).toHaveLength(2);
  const contributionWinnerIndex = contributionStatuses.indexOf(200);
  const contributionWinner = await contributionRace[contributionWinnerIndex]!.json() as {
    draftRevision: string; predecessor: string };
  expect(contributionWinner.predecessor).toBe(contribution.draftRevision);
  const loserIndex = contributionStatuses.findIndex(status => status === 409);
  const loserRetry = await editor.send('/v1/contribution-edits',
    contributionEdit(`Contribution edit ${loserIndex}`, contribution.draftRevision),
    contributionKeys[loserIndex]);
  expect(loserRetry.status).toBe(409);
  expect(await loserRetry.json()).toMatchObject({ code: 'stale_head' });
  const contributionMerge = await editor.send('/v1/contribution-edits', contributionEdit(
    `Contribution edit ${contributionWinnerIndex} + ${loserIndex}`, contributionWinner.draftRevision));
  expect(contributionMerge.status).toBe(200);
  const mergedContribution = await contributionMerge.json() as { draftRevision: string;
    predecessor: string };
  expect(mergedContribution.predecessor).toBe(contributionWinner.draftRevision);
  const readDraft = (revision: string) => editor.read(`/v1/contributions/${
    contribution.contribution.split('/').at(-1)}/drafts/${revision.split('/').at(-1)}`);
  for (const [revision, body, predecessor] of [
    [contribution.draftRevision, 'Contribution base', undefined],
    [contributionWinner.draftRevision, `Contribution edit ${contributionWinnerIndex}`,
      contribution.draftRevision],
    [mergedContribution.draftRevision,
      `Contribution edit ${contributionWinnerIndex} + ${loserIndex}`,
      contributionWinner.draftRevision],
  ] as const) {
    const exact = await readDraft(revision);
    expect(exact.status).toBe(200);
    const read = await exact.json() as { body: string; predecessor?: string };
    expect(read.body).toBe(body);
    if (predecessor) expect(read.predecessor).toBe(predecessor);
  }
}, 120_000);

test('BOOK10: offline replay keeps the queued command identity and current CAS and authority decide it', async () => {
  const { member, environment, access, content, accessPool, draftHead, revisions, admissions,
    draftReceipt } = await stack();
  const offline = await member('offline');
  const other = await member('other-member');
  const base = await offline.save('Offline base paragraph', null);

  // The offline client persisted base, local intent and operation key before losing its link.
  const queued = { key: `book10-offline-${randomUUID()}`, expectedHead: base.revisionId,
    body: 'Offline paragraph typed without a connection' };
  // Another device of the same Agent edits the same head meanwhile.
  const remoteEdit = await offline.send('/v1/content-drafts',
    offline.draft('Remote paragraph saved while the client was offline', base.revisionId),
    `book10-remote-${randomUUID()}`);
  expect(remoteEdit.status).toBe(201);
  const remoteHead = (await remoteEdit.json() as { revisionId: string }).revisionId;

  // Reconnect: a replay without a current Account assertion never reaches Access or Content.
  const unauthenticated = await offline.send('/v1/content-drafts',
    offline.draft(queued.body, queued.expectedHead), queued.key, null);
  expect(unauthenticated.status).toBe(401);
  expect(await admissions([queued.key])).toEqual([]);
  const foreignSession = await other.send('/v1/content-drafts',
    offline.draft(queued.body, queued.expectedHead), queued.key);
  expect(foreignSession.status).toBe(403);

  const replay = () => offline.send('/v1/content-drafts',
    offline.draft(queued.body, queued.expectedHead), queued.key);
  const staleReplay = await replay();
  expect(staleReplay.status).toBe(409);
  expect(await staleReplay.json()).toMatchObject({ code: 'stale_head' });
  const [queuedAdmission] = await admissions([queued.key]);
  expect(queuedAdmission).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled',
    request_digest: offline.intentDigest(queued.body, queued.expectedHead) });
  expect(await draftReceipt(queuedAdmission!.id)).toEqual([{ outcome: 'stale_head',
    revision_id: null, request_digest: queuedAdmission!.request_digest,
    reason: 'expected head differs' }]);
  // The same key stays bound to that exact command: repeated replay keeps its outcome,
  // and silently rebasing the queued intent under the old key is refused.
  const secondReplay = await replay();
  expect(secondReplay.status).toBe(409);
  expect(await secondReplay.json()).toMatchObject({ code: 'stale_head' });
  const rebasedUnderOldKey = await offline.send('/v1/content-drafts',
    offline.draft(queued.body, remoteHead), queued.key);
  expect(rebasedUnderOldKey.status).toBe(409);
  expect(await rebasedUnderOldKey.json()).toMatchObject({ code: 'idempotency_conflict' });
  expect(await admissions([queued.key])).toHaveLength(1);
  expect(await draftHead(offline.variantId)).toBe(remoteHead);

  // The preserved local input is resubmitted as a new command on the observed head.
  const rebased = await offline.save(queued.body, remoteHead, `book10-rebased-${randomUUID()}`);
  expect(rebased.predecessor).toBe(remoteHead);
  const history = await revisions(offline.variantId);
  expect(history).toHaveLength(3);
  expect(history.find(row => row.id === rebased.revisionId)).toEqual({
    id: rebased.revisionId, predecessor: remoteHead, body: { body: queued.body } });
  expect(history.find(row => row.id === remoteHead)?.predecessor).toBe(base.revisionId);

  // Lost response: the committed command reconciles its receipt instead of editing twice.
  const lost = { key: `book10-lost-${randomUUID()}`,
    body: 'Committed before the connection dropped' };
  const lostSend = () => offline.send('/v1/content-drafts',
    offline.draft(lost.body, rebased.revisionId), lost.key);
  expect((await lostSend()).status).toBe(201);
  const lostReplay = await lostSend();
  expect(lostReplay.status).toBe(200);
  const lostCommitted = await lostReplay.json() as { revisionId: string; replayed: boolean };
  expect(lostCommitted.replayed).toBe(true);
  expect(await revisions(offline.variantId)).toHaveLength(4);

  // In flight at revocation: Access admitted the command but Content never saw it.
  const scope = `content:draft:${offline.work}`;
  const inFlight = { key: `book10-inflight-${randomUUID()}`,
    body: 'Admitted before revocation, never saved' };
  const inFlightDigest = offline.intentDigest(inFlight.body, lostCommitted.revisionId);
  const registered = await access.register({ principal: offline.principal,
    actingSubject: offline.actor, scope, action: 'content.draft',
    idempotencyKey: inFlight.key, requestDigest: inFlightDigest });
  await access.claim(registered.id, inFlightDigest);
  const neverSent = { key: `book10-queued-${randomUUID()}`,
    body: 'Queued offline, first sent after revocation' };
  const revoked = await strongRevokeWorkScope(environment, access, scope, '0', content);
  expect(revoked).toMatchObject({ scope, status: 'complete', pending: 0 });
  expect(await draftReceipt(registered.id)).toEqual([{ outcome: 'rejected', revision_id: null,
    request_digest: inFlightDigest, reason: 'admission-fenced' }]);

  const inFlightReplay = await offline.send('/v1/content-drafts',
    offline.draft(inFlight.body, lostCommitted.revisionId), inFlight.key);
  expect(inFlightReplay.status).toBe(403);
  expect(await inFlightReplay.json()).toMatchObject({ code: 'authority_denied' });
  const queuedAfterRevocation = await offline.send('/v1/content-drafts',
    offline.draft(neverSent.body, lostCommitted.revisionId), neverSent.key);
  expect(queuedAfterRevocation.status).toBe(403);
  expect(await admissions([neverSent.key])).toEqual([]);
  // A committed receipt is still reconciled exactly; it creates no second revision.
  const committedAfterScopeFence = await lostSend();
  expect(committedAfterScopeFence.status).toBe(200);
  expect(await committedAfterScopeFence.json()).toMatchObject({
    revisionId: lostCommitted.revisionId, replayed: true });
  expect(await draftHead(offline.variantId)).toBe(lostCommitted.revisionId);
  expect(await revisions(offline.variantId)).toHaveLength(4);

  // Principal revocation removes even receipt reconciliation from the revoked session.
  const epoch = (await accessPool.query<{ enforcement_epoch: string }>(
    'SELECT enforcement_epoch FROM access.principal WHERE id = $1', [offline.principalId]))
    .rows[0]!.enforcement_epoch;
  const principalFence = await strongRevokeWorkPrincipal(environment, access,
    offline.principalId, epoch, content);
  expect(principalFence).toMatchObject({ status: 'complete', pending: 0 });
  const afterPrincipalFence = await lostSend();
  expect(afterPrincipalFence.status).toBe(403);
  expect(await afterPrincipalFence.json()).toMatchObject({ code: 'authority_denied' });
  expect(await revisions(offline.variantId)).toHaveLength(4);
  expect(await draftHead(offline.variantId)).toBe(lostCommitted.revisionId);
  const retained = (await content.readExactBatch([base.revisionId, remoteHead,
    rebased.revisionId, lostCommitted.revisionId], async ids => new Set(ids)))
    .map(result => result.status === 'available' ? result.body.body : result.status);
  expect(retained).toEqual(['Offline base paragraph',
    'Remote paragraph saved while the client was offline', queued.body, lost.body]);
}, 120_000);
