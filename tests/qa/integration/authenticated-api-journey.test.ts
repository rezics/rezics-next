import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { ContentComments } from '../../../services/content/src/comments.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { relayContentProjectionOnce }
  from '../../../services/main/src/modules/content-publication/relay.ts';

const root = resolve(import.meta.dir, '../../..');
const scope = 'openid work:create work:edit work:read comment:create space:create realm:classify realm:adopt realm:reject classification:define classification:decide';

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

test('IAM01/IAM21/WORK01/WORK09/BOOK04/CTX01/CTX02/SEARCH01: authenticated S2 API journey', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_DATABASE_URL
    || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `authenticated-api-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  try {
    const signUp = async (name: string) => {
      const email = `api-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await account.handle(new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { user: { id: string } };
      return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
    const mainClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'S2 Main verifier', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const webClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'S2 API browser', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope, skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, `${base}/api/auth`, member.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);

    // Operator fixture grants real Access rows; every command still registers and claims
    // its own admission, with no fabricated principal, receipt or graph mutation.
    const grant = async (resourceScope: string, action: string) => {
      const client = await accessPool.connect();
      try {
        await client.query('BEGIN');
        const fence = await client.query<{ open: boolean }>(
          'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
        if (fence.rows[0]?.open !== true) throw new Error('Access recovery fence is closed');
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
    await grant('work:create:root', 'work.create');
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: member.email, password: member.password }),
    });
    expect(signIn.status).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: webClient.client_id, redirect_uri: redirectUri, scope,
      state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
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
        code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }),
    });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json() as { access_token: string }).access_token;
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const comments = new ContentComments(contentPool);
    const cursor = new ContentProjectionCursor(contentPool);
    const consumer = `s2-${randomUUID()}`;
    await cursor.initialize(consumer);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const environment = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: join(state, 'objects') };
    const access = new AccessAdmissionRegistry(accessPool);
    const main = createMainApp(fuseki, { environment,
      account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
        audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
        introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: mainClient.client_id, clientSecret: mainClient.client_secret! }),
      access,
      content, contentAuthoring: content, comments,
      contentProjection: { content, cursor, consumer } });
    const send = (path: string, body: object, protectedCommand = true,
      key = `s2-${randomUUID()}`) => main.handle(new Request(`http://main.local${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(protectedCommand ? { authorization: `Bearer ${token}`,
            'idempotency-key': key } : {}) },
        body: JSON.stringify(body),
      }));
    const post = async <T>(path: string, body: object, protectedCommand = true,
      key?: string): Promise<T> => {
      const response = await send(path, body, protectedCommand, key);
      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
      }
      return await response.json() as T;
    };
    const marker = `s2journey${randomUUID().replaceAll('-', '')}`;
    const work = await post<{ work: string; mainVersion: string; workRevision: string;
      mainRevision: string }>('/v1/works', { profile: 'metadata-only-v1',
        title: `S2 ${marker}`, actingSubject: actor });
    expect(work.work).not.toBe(work.mainVersion);
    expect(work.workRevision).not.toBe(work.mainRevision);
    await grant(`work:read:${work.work}`, 'work.read');
    await grant(`work:edit:${work.work}`, 'work.edit');
    await grant(`contribution:create:${work.work}`, 'contribution.create');
    const originalBody = `${marker} original published body`;
    const draft = await post<{ contribution: string; draftRevision: string }>('/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: originalBody, actingSubject: actor });
    await grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const published = await post<{ publicationDecision: string }>('/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor });
    await grant(`publication:select:${work.mainVersion}`, 'publication.select');
    const selected = await post<{ selection: string; selectedDraft: string;
      mainRevision: string }>('/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer', actingSubject: actor });
    expect(selected.selectedDraft).toBe(draft.draftRevision);
    expect(selected.mainRevision).not.toBe(work.mainRevision);
    const readMain = (revision: string, actingSubject = actor, mainVersion = work.mainVersion) =>
      main.handle(new Request(`http://main.local/v1/main-versions/${mainVersion.split('/').at(-1)}`
        + `/revisions/${revision.split('/').at(-1)}?actingSubject=${encodeURIComponent(actingSubject)}`,
      { headers: { authorization: `Bearer ${token}` } }));
    const oldMain = await readMain(work.mainRevision);
    expect(oldMain.status).toBe(200);
    expect(await oldMain.json()).toMatchObject({ revision: work.mainRevision,
      mainVersion: work.mainVersion, work: work.work, hostingPolicy: 'metadata-only',
      defaultSelection: null });
    const selectedMain = await readMain(selected.mainRevision);
    expect(selectedMain.status).toBe(200);
    expect(await selectedMain.json()).toMatchObject({ revision: selected.mainRevision,
      mainVersion: work.mainVersion, work: work.work, hostingPolicy: 'metadata-only',
      predecessor: work.mainRevision, defaultSelection: selected.selection });
    expect((await readMain(work.mainRevision, `https://rezics.com/id/${randomUUID()}`)).status)
      .toBe(404);
    expect((await readMain(work.mainRevision, actor,
      `https://rezics.com/id/${randomUUID()}`)).status).toBe(404);

    await grant('space:create:root', 'space.create');
    const realmA = await post<{ realm: string }>('/v1/spaces', {
      profile: 'space-realm-v1', name: `S2 A ${marker}`, capabilities: ['realm'], actingSubject: actor });
    const realmB = await post<{ realm: string }>('/v1/spaces', {
      profile: 'space-realm-v1', name: `S2 B ${marker}`, capabilities: ['realm'], actingSubject: actor });
    expect(realmA.realm).not.toBe(realmB.realm);
    for (const realm of [realmA.realm, realmB.realm]) {
      await grant(`classification:context:${realm}`, 'classification.context.configure');
      await post('/v1/classification-contexts', { profile: 'classification-context-v1',
        realm, actingSubject: actor });
    }
    const alternativeMarker = `realmvariant${randomUUID().replaceAll('-', '')}`;
    const alternative = await post<{ contribution: string; draftRevision: string }>(
      '/v1/contributions', { profile: 'text-contribution-v1', work: work.work,
        language: 'en', body: `${marker} ${alternativeMarker} realm alternative`,
        actingSubject: actor });
    await grant(`contribution:publish:${alternative.contribution}`, 'contribution.publish');
    const alternativePublication = await post<{ publicationDecision: string }>(
      '/v1/contribution-publications', { profile: 'text-publication-v1',
        contribution: alternative.contribution, expectedDraftHead: alternative.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution',
        disclosure: 'public', actingSubject: actor });
    await grant(`publication:adopt:${realmB.realm}`, 'publication.adopt');
    const realmAdoptionInput = { profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: realmB.realm }, work: work.work,
      mainVersion: work.mainVersion, contribution: alternative.contribution,
      publicationDecision: alternativePublication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
      actingSubject: actor };
    const adopted = await post<{ selection: string }>('/v1/publication-selections',
      realmAdoptionInput);
    expect(adopted.selection).toBeTruthy();
    const staleAdoption = await send('/v1/publication-selections', realmAdoptionInput);
    expect(staleAdoption.status).toBe(409);
    await grant(`publication:reject:${realmA.realm}`, 'publication.reject');
    const rejected = await post<{ rejection: string }>('/v1/publication-rejections', {
      profile: 'realm-local-rejection-v1', context: { kind: 'realm-local', id: realmA.realm },
      work: work.work, mainVersion: work.mainVersion, expectedSelectionHead: null,
      decisionBasis: 'realm-manager-review', reasonCode: 'not-approved', actingSubject: actor });
    expect(rejected.rejection).toBeTruthy();
    const selectedIn = (realm: string) => main.handle(new Request(
      `http://main.local/v1/realms/${realm.split('/').at(-1)}`
      + `/main-versions/${work.mainVersion.split('/').at(-1)}/selection`));
    const realmASelection = await selectedIn(realmA.realm);
    expect(realmASelection.status).toBe(200);
    expect(await realmASelection.json()).toMatchObject({ status: 'suppressed',
      reason: 'realm-rejection', rejection: rejected.rejection });
    const realmBSelection = await selectedIn(realmB.realm);
    expect(realmBSelection.status).toBe(200);
    expect(await realmBSelection.json()).toMatchObject({ reason: 'realm-adoption',
      selection: adopted.selection, contribution: alternative.contribution,
      body: `${marker} ${alternativeMarker} realm alternative` });
    const mainAlternative = await post<{ total: number }>('/v1/queries', {
      profile: 'public-main-phrase-v1', phrase: alternativeMarker, language: 'en' }, false);
    const realmAlternative = async (realm: string) => post<{ total: number;
      results: Array<{ work: string }> }>('/v1/queries', {
        profile: 'public-realm-phrase-v1', context: { kind: 'realm-local', id: realm },
        phrase: alternativeMarker, language: 'en' }, false);
    expect(mainAlternative.total).toBe(0);
    expect((await realmAlternative(realmA.realm)).total).toBe(0);
    expect((await realmAlternative(realmB.realm)).results).toMatchObject([{ work: work.work }]);
    await grant('classification:define:global', 'classification.proposition.define');
    const proposition = await post<{ sense: string }>('/v1/classification-propositions', {
      profile: 'classification-proposition-v1', label: `S2 ${marker}`, actingSubject: actor });
    const decide = async (context: { kind: 'global' } | { kind: 'realm-classification'; id: string },
      outcome: 'accepted' | 'rejected') => {
      const decisionScope = context.kind === 'global' ? 'classification:decide:global'
        : `classification:decide:${context.id}`;
      await grant(decisionScope, 'classification.decision.set');
      return post<{ decision: string }>('/v1/classification-decisions', {
        profile: 'classification-direct-decision-v1', context,
        work: work.work, mainVersion: work.mainVersion, sense: proposition.sense,
        expectedDecisionHead: null, outcome, actingSubject: actor });
    };
    await decide({ kind: 'global' }, 'accepted');
    await decide({ kind: 'realm-classification', id: realmA.realm }, 'rejected');
    await grant(`classification:decide:${realmB.realm}`, 'classification.decision.set');
    const realmBDecision = { profile: 'classification-direct-decision-v1',
      context: { kind: 'realm-classification', id: realmB.realm },
      work: work.work, mainVersion: work.mainVersion, sense: proposition.sense,
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor };
    const concurrentDecisions = await Promise.all([
      send('/v1/classification-decisions', realmBDecision),
      send('/v1/classification-decisions', realmBDecision),
    ]);
    expect(concurrentDecisions.map(response => response.status).sort()).toEqual([201, 409]);
    expect(await concurrentDecisions.find(response => response.status === 409)!.json())
      .toMatchObject({ code: 'stale_head' });
    const classified = async (realm: string) => post<{ total: number;
      results: Array<{ work: string; classification: { source: string } }> }>('/v1/queries', {
      profile: 'public-realm-classified-phrase-v1',
      context: { kind: 'realm-local', id: realm }, phrase: marker, language: 'en',
      sense: proposition.sense }, false);
    expect((await classified(realmA.realm)).results).toEqual([]);
    expect((await classified(realmB.realm)).results).toMatchObject([
      { work: work.work, classification: { source: 'local' } },
    ]);

    const variantId = `urn:rezics:variant:${randomUUID()}`;
    await grant(`content:draft:${work.work}`, 'content.draft');
    const contentMarker = `contentjourney${randomUUID().replaceAll('-', '')}`;
    const save = (body: string, expectedHead: string | null) => post<{
      revisionId: string; predecessor: string | null;
      sourcePosition: { dataEpoch: string; sequence: string } }>('/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: work.work, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead, body, actingSubject: actor });
    const oldParagraph = `${contentMarker} original paragraph`;
    const originalContent = `Opening paragraph\n${oldParagraph}\nClosing paragraph`;
    const first = await save(originalContent, null);
    const commentInput = { profile: 'content-paragraph-comment-v1',
      resourceId: work.work, revisionId: first.revisionId,
      exact: oldParagraph, body: `Comment on ${contentMarker}`, actingSubject: actor };
    const exact = (await content.readExactBatch([first.revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Content first revision unavailable');
    const publicationInput = {
      profile: 'content-publication-v1', preparationId: `s2-${randomUUID()}`,
      revisionId: first.revisionId, expectedDigest: exact.reference.byteDigest,
      expectedContentEpoch: first.sourcePosition.dataEpoch, resourceId: work.work,
      variantId, expectedPublicationHead: null, actingSubject: actor };
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [`content:publish:${variantId}`]);
    const deniedPublication = await send('/v1/content-publications', publicationInput);
    expect(deniedPublication.status).toBe(403);
    expect((await content.readPublicationPreparation(publicationInput.preparationId))).toBeNull();
    await grant(`content:publish:${variantId}`, 'content.publish');
    const publicationKey = `s2-publication-${randomUUID()}`;
    const publication = await post<{ status: string; decision: string }>('/v1/content-publications',
      publicationInput, true, publicationKey);
    expect(publication.status).toBe('active');
    const replayedPublication = await send('/v1/content-publications', publicationInput,
      true, publicationKey);
    expect(replayedPublication.status).toBe(200);
    expect(await replayedPublication.json()).toMatchObject({ status: 'active', replayed: true,
      decision: publication.decision });
    await grant(`content:search-eligibility:${variantId}`, 'content.search-eligibility');
    const eligibility = await post<{ decision: string }>('/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: work.work, variantId,
      publicationDecision: publication.decision, expectedEligibilityHead: null,
      actingSubject: actor, rightsBasis: 'original-contribution', disclosure: 'public' });
    expect(eligibility.decision).toBeTruthy();
    while (BigInt((await cursor.read(consumer)).sequence)
      < BigInt((await content.ownerPosition()).sequence)) {
      const event = await relayContentProjectionOnce(environment, content, cursor, consumer);
      if (!event) throw new Error('Content projection stopped before owner cut');
    }
    const publicContent = await post<{ total: number; results: Array<{ revision: string }> }>(
      '/v1/queries', { profile: 'public-content-phrase-v1', phrase: contentMarker,
        language: 'en' }, false);
    expect(publicContent.total).toBe(1);
    expect(publicContent.results[0]?.revision)
      .toBe(`urn:rezics:content:revision:${first.revisionId}`);
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [`content:comment:${work.work}`]);
    expect((await send('/v1/content-comments', commentInput)).status).toBe(403);
    await grant(`content:comment:${work.work}`, 'content.comment');
    const commentKey = `s2-comment-${randomUUID()}`;
    const comment = await post<{ comment: string; target: { source: string;
      selector: { exact: string } }; revisionId: string }>('/v1/content-comments',
      commentInput, true, commentKey);
    expect(comment.target).toMatchObject({ source: `urn:rezics:content:revision:${first.revisionId}`,
      selector: { exact: oldParagraph } });
    const commentReplay = await send('/v1/content-comments', commentInput, true, commentKey);
    expect(commentReplay.status).toBe(200);
    expect(await commentReplay.json()).toMatchObject({ comment: comment.comment, replayed: true });
    const invalidComment = await send('/v1/content-comments', {
      ...commentInput, exact: 'paragraph absent from retained revision' });
    expect(invalidComment.status).toBe(400);
    const second = await save(`${contentMarker} private edit`, first.revisionId);
    expect(second.predecessor).toBe(first.revisionId);
    const newRead = await main.handle(new Request(
      `http://main.local/v1/content-revisions/${second.revisionId}`
        + `?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${token}` } }));
    expect(newRead.status).toBe(200);
    const currentDraft = await newRead.json() as { body: { body: string } };
    expect(currentDraft.body.body).not.toContain(oldParagraph);
    const readComment = (actingSubject = actor) => main.handle(new Request(
      `http://main.local/v1/content-comments/${comment.comment.split('/').at(-1)}`
        + `?actingSubject=${encodeURIComponent(actingSubject)}`,
      { headers: { authorization: `Bearer ${token}` } }));
    const historicalComment = await readComment();
    expect(historicalComment.status).toBe(200);
    expect(await historicalComment.json()).toMatchObject({ comment: comment.comment,
      revisionId: first.revisionId, resolvedText: oldParagraph,
      target: { selector: { exact: oldParagraph } } });
    const laterComment = await post<{ comment: string }>('/v1/content-comments', {
      ...commentInput, body: `Later comment on ${contentMarker}` });
    const readCommentPage = (cursor?: string, actingSubject = actor) => {
      const url = new URL(`http://main.local/v1/content-revisions/${first.revisionId}/comments`);
      url.searchParams.set('actingSubject', actingSubject);
      url.searchParams.set('pageSize', '1');
      if (cursor) url.searchParams.set('cursor', cursor);
      return main.handle(new Request(url.toString(),
        { headers: { authorization: `Bearer ${token}` } }));
    };
    const firstPage = await readCommentPage();
    expect(firstPage.status).toBe(200);
    const firstListed = await firstPage.json() as { comments: Array<{ comment: string;
      resolvedText: string }>; next: string | null };
    expect(firstListed.comments).toMatchObject([{ comment: comment.comment,
      resolvedText: oldParagraph }]);
    expect(firstListed.next).toBeTruthy();
    const secondPage = await readCommentPage(firstListed.next!);
    expect(secondPage.status).toBe(200);
    expect(await secondPage.json()).toMatchObject({ comments: [{ comment: laterComment.comment,
      resolvedText: oldParagraph }], next: null });
    expect((await readCommentPage(firstListed.next!,
      `https://rezics.com/id/${randomUUID()}`)).status).toBe(404);
    expect((await readCommentPage('invalid')).status).toBe(400);
    expect((await readComment(`https://rezics.com/id/${randomUUID()}`)).status).toBe(404);
    const staleEdit = await send('/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: work.work, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: first.revisionId, body: 'stale Content edit', actingSubject: actor });
    expect(staleEdit.status).toBe(409);
    const stillPublic = await post<{ total: number; results: Array<{ revision: string }> }>(
      '/v1/queries', { profile: 'public-content-phrase-v1', phrase: contentMarker,
        language: 'en' }, false);
    expect(stillPublic.results[0]?.revision)
      .toBe(`urn:rezics:content:revision:${first.revisionId}`);
    const oldRead = await main.handle(new Request(
      `http://main.local/v1/content-revisions/${first.revisionId}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${token}` } }));
    expect(oldRead.status).toBe(200);
    expect(await oldRead.json()).toMatchObject({ reference: { revisionId: first.revisionId },
      body: { body: originalContent } });
    const edit = await post<{ revision: string; predecessor: string }>('/v1/content-edits', {
      profile: 'metadata-only-v1', work: work.work, expectedHead: work.workRevision,
      title: `S2 edited ${marker}`, actingSubject: actor });
    expect(edit.predecessor).toBe(work.workRevision);
    const prior = await main.handle(new Request(
      `http://main.local/v1/revisions/${work.workRevision.split('/').at(-1)}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${token}` } }));
    expect(prior.status).toBe(200);
    expect(await prior.json()).toMatchObject({ revision: work.workRevision,
      title: `S2 ${marker}` });
    // IAM21: historical anchors remain stored, while delivery follows the
    // current Work disclosure gate after authority is revoked.
    const readWork = (revision: string) => main.handle(new Request(
      `http://main.local/v1/revisions/${revision.split('/').at(-1)}`
        + `?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${token}` } }));
    const readContent = (revision: string) => main.handle(new Request(
      `http://main.local/v1/content-revisions/${revision}`
        + `?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: `Bearer ${token}` } }));
    const missing = randomUUID();
    expect((await readContent(missing)).status).toBe(404);
    expect((await readWork(`https://rezics.com/id/${missing}`)).status).toBe(404);
    expect((await readMain(`https://rezics.com/id/${missing}`)).status).toBe(404);
    const closed = await access.strongCloseScope(`work:read:${work.work}`, '0');
    expect(closed.pending).toBe(0);
    expect((await readContent(first.revisionId)).status).toBe(404);
    expect((await readWork(work.workRevision)).status).toBe(404);
    expect((await readMain(work.mainRevision)).status).toBe(404);
    expect((await readComment()).status).toBe(404);
    expect((await readCommentPage()).status).toBe(404);
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
