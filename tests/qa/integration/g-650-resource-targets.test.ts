import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { RealmReplyThreadStore } from '../../../services/main/src/modules/realm-reply/thread-store.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

interface Work { work: string; mainVersion: string; workRevision: string }

test('G-650: API discussions keep SAO occurrence, character, release and metadata Work roots distinct', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration QA tier');
  const directory = resolve('.temp', `g-650-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid agent:create collection:edit semantic:read work:create work:edit work:read comment:create realm:adopt space:create rating:configure rating:submit');
  const content = new ContentCore(f.pool);
  const structureObjects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await structureObjects.initialize();
  const replies = new RealmReplyStore(new RealmReplyContentStore(f.pool), content, f.access, f.env);
  const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
    access: f.access, content, contentAuthoring: content, realmReplies: replies, structureObjects,
    realmReplyThreads: new RealmReplyThreadStore(f.pool, f.accessPool), reviews: new ReaderReviews(f.accessPool),
    agentProvisioning: new AgentProvisioning(f.accessPool, f.env), personPreferences: new PersonPreferencesStore(f.accessPool),
    profiles: new ProfilesAccess(f.accessPool) });
  const call = (method: string, path: string, body?: object, authenticated = true, key = randomUUID()) =>
    app.handle(new Request(`http://main.local${path}`, { method, headers: {
      ...(authenticated ? { authorization: `Bearer ${f.account.tokenA}` } : {}),
      'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text();
    if (response.status !== status) throw new Error(`${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  const work = (title: string) => call('POST', '/v1/works', { profile: 'metadata-only-v1', language: 'en',
    title, semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor }).then(response => json<Work>(response, 201));
  const publish = async (w: Work) => {
    await f.grant(`contribution:create:${w.work}`, 'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: w.work, language: 'en', body: 'Aincrad text', actingSubject: f.actor }), 201);
    await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const publication = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: f.actor }), 201);
    await f.grant(`publication:select:${w.mainVersion}`, 'publication.select');
    await json(await call('POST', '/v1/publication-selections', { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: w.mainVersion }, work: w.work, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer', actingSubject: f.actor }), 201);
  };
  const occurrence = async (w: Work) => {
    await f.grant(`work:edit:${w.work}`, 'work.edit');
    const structure = await json<{ structure: string; revision: string }>(await call('POST', '/v1/compositions', {
      profile: 'book-composition', work: w.work, mainVersion: w.mainVersion, actingSubject: f.actor }), 201);
    const result = await json<{ revision: string; occurrences: string[] }>(await call('POST',
      `/v1/compositions/${shortId(structure.structure)}/changes`, { profile: 'book-composition',
        expectedHead: structure.revision, actingSubject: f.actor, operations: [{ op: 'insert',
          parent: structure.structure, position: 'last', role: 'chapter', target: 'https://schema.org/DigitalDocument',
          label: { value: 'Aincrad chapter one', language: 'en' } }] }));
    return { target: result.occurrences[0]!, revision: result.revision, structure: structure.structure };
  };
  try {
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try { await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [f.account.a.id]); }
    finally { await accountPool.end(); }
    f.account.tokenA = await f.account.tokenFor(f.account.a);
    const reviewer = await json<{ agent: string }>(await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'SAO reader' }), 201);
    const readerGrant = async (scope: string, action: string) => {
      await f.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await f.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), f.principalId, reviewer.agent, action]);
      await f.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), reviewer.agent, scope, action]);
    };
    const sao = { web: await work('Sword Art Online'), bunko: await work('Sword Art Online'),
      unpublished: await work('SAO editorial notes') };
    await publish(sao.web);
    await publish(sao.bunko);
    const chapter = await occurrence(sao.web);
    const hidden = await occurrence(sao.unpublished);
    await f.grant(`work:read:${sao.unpublished.work}`, 'work.read');
    await readerGrant(`work:read:${sao.unpublished.work}`, 'work.read');
    await f.grant('semantic:create:root', 'semantic.change');
    const character = await json<{ component: string; revision: string }>(await call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor,
      state: { component: 'resource', types: ['https://rezics.com/vocab/Character'], properties: [{
        predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: 'Kirito', language: 'en', direction: 'ltr' } }] } }), 201);
    await f.grant(`semantic:read:${character.component}`, 'semantic.read');
    await readerGrant(`semantic:read:${character.component}`, 'semantic.read');
    await f.grant(`work:edit:${sao.bunko.work}`, 'work.edit');
    const release = nativeId();
    const paperback = await json<{ release: string; revision: string }>(await call('PUT',
      `/v1/works/${shortId(sao.bunko.work)}/releases/${shortId(release)}`, { profile: 'release-v1',
        expectedHead: null, actingSubject: f.actor, id: release, kind: 'formal', status: 'official',
        contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
        title: { value: 'SAO paperback', language: 'en' }, editionStatement: null, publisher: 'Yen Press',
        publicationYear: 2014, isbn13: null, originalUrl: null, fixedRelease: null, coverage: null, evidence: null }));
    await f.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string }>(await call('POST', '/v1/spaces', { profile: 'space-realm-v1',
      name: 'SAO discussions', capabilities: ['realm'], actingSubject: f.actor }), 201);
    await f.grant(`review:decide:${realm.realm}`, 'review.decide');
    await f.grant(`reply:place:${realm.realm}`, 'reply.place');
    const targets = [chapter, { target: character.component, revision: character.revision },
      { target: paperback.release, revision: paperback.revision },
      { target: sao.web.work, revision: sao.web.workRevision },
      { target: sao.unpublished.work, revision: sao.unpublished.workRevision }];
    const discussion = (target: string, authenticated = true) => call('GET', `/v1/resources/${shortId(target)}/discussion`
      + (authenticated ? `?actingSubject=${encodeURIComponent(f.actor)}` : ''), undefined, authenticated);
    const retained: { input: { profile: string; reply: string; variantId: string; rootTarget: string;
      rootRevision: string; language: string; direction: string; expectedHead: null; body: string; actingSubject: string };
      key: string; identityKey: string; revisionId: string }[] = [];
    for (const root of targets) {
      const reply = nativeId();
      await f.grant(`content:draft:${reply}`, 'content.draft');
      await f.grant(`reply:create:${root.target}`, 'reply.create');
      const input = { profile: 'member-reply-draft-v1', reply, variantId: `urn:rezics:variant:${randomUUID()}`,
        rootTarget: root.target, rootRevision: root.revision, language: 'en', direction: 'ltr', expectedHead: null,
        body: `Discussion about ${root.target}`, actingSubject: f.actor };
      const key = randomUUID();
      const draft = await json<{ revisionId: string }>(await call('POST', '/v1/member-reply-drafts', input, true, key), 201);
      const identityKey = randomUUID();
      retained.push({ input, key, identityKey, revisionId: draft.revisionId });
      expect(await json(await call('POST', '/v1/member-reply-drafts', input, true, key)))
        .toMatchObject({ revisionId: draft.revisionId, replayed: true });
      await json(await call('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply,
        variantId: input.variantId, revisionId: draft.revisionId, author: f.actor, rootTarget: root.target,
        rootRevision: root.revision, parentReply: null, parentRevision: null, contextRevision: null }, true, identityKey), 201);
      const current = await json<{ revisionDigest: string }>(await call('GET',
        `/v1/member-replies/${shortId(reply)}?actingSubject=${encodeURIComponent(f.actor)}`));
      const approved = await json<{ decisionId: string }>(await call('POST', '/v1/realm-reply-reviews', {
        profile: 'realm-reply-review-v1', realm: realm.realm, reply, revisionId: draft.revisionId,
        revisionDigest: current.revisionDigest, expectedGeneration: '0', supersedes: null,
        outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
        dependencyDigest: createHash('sha256').update(root.revision).digest('hex'), reasonReference: null,
        actingSubject: f.actor }), 201);
      await json(await call('POST', '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1',
        realm: realm.realm, reply, revisionId: draft.revisionId, revisionDigest: current.revisionDigest,
        reviewDecisionId: approved.decisionId, expectedHead: null, actingSubject: f.actor }), 201);
      expect(await json(await discussion(root.target))).toMatchObject({ items: [{ reply, realm: realm.realm }] });
      expect(await json(await call('GET', `/v1/realms/${shortId(realm.realm)}/threads/${shortId(reply)}`
        + `?actingSubject=${encodeURIComponent(reviewer.agent)}`))).toMatchObject({ work: { id: root.target } });
    }
    const threads = await json<{ items: { work: { id: string } }[] }>(await call('GET',
      `/v1/realms/${shortId(realm.realm)}/threads?actingSubject=${encodeURIComponent(reviewer.agent)}&sort=new`));
    expect(threads.items.map(item => item.work.id).sort()).toEqual(targets.map(root => root.target).sort());
    // Changing an owner head must not erase a discussion anchored to retained evidence.
    await json(await call('POST', `/v1/compositions/${shortId(chapter.structure)}/changes`, {
      profile: 'book-composition', expectedHead: chapter.revision, actingSubject: f.actor,
      operations: [{ op: 'insert', parent: chapter.structure, position: 'last', role: 'chapter',
        target: 'https://schema.org/DigitalDocument', label: { value: 'Aincrad chapter two', language: 'en' } }] }));
    await f.grant(`work:edit:${sao.web.work}`, 'work.edit');
    await json(await call('POST', '/v1/content-edits', { profile: 'metadata-only-v1', work: sao.web.work,
      expectedHead: sao.web.workRevision, title: 'Sword Art Online revised', actingSubject: f.actor }));
    await f.grant(`semantic:edit:${character.component}`, 'semantic.change');
    const editedCharacter = await json<{ revision: string }>(await call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', target: character.component, expectedHead: character.revision,
      actingSubject: f.actor, state: { component: 'resource', types: ['https://rezics.com/vocab/Character'],
        properties: [{ predicate: 'https://schema.org/name', value: { kind: 'language-string',
          lexical: 'Kirito revised', language: 'en', direction: 'ltr' } }] } }));
    for (const { input, key, identityKey, revisionId } of retained) {
      expect(await json(await discussion(input.rootTarget))).toMatchObject({ items: [{ reply: input.reply }] });
      expect(await json(await call('GET', `/v1/realms/${shortId(realm.realm)}/threads/${shortId(input.reply)}`
        + `?actingSubject=${encodeURIComponent(reviewer.agent)}`))).toMatchObject({ rootRevision: input.rootRevision });
      expect(await json(await call('POST', '/v1/member-reply-drafts', input, true, key)))
        .toMatchObject({ revisionId, replayed: true });
      expect(await json(await call('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1',
        reply: input.reply, variantId: input.variantId, revisionId, author: f.actor,
        rootTarget: input.rootTarget, rootRevision: input.rootRevision, parentReply: null,
        parentRevision: null, contextRevision: null }, true, identityKey))).toMatchObject({ replayed: true });
    }
    expect((await json<{ items: unknown[] }>(await call('GET', `/v1/realms/${shortId(realm.realm)}/threads`
      + `?actingSubject=${encodeURIComponent(reviewer.agent)}&sort=new`))).items).toHaveLength(targets.length);
    for (const target of [chapter.target, character.component, paperback.release]) {
      expect((await call('GET', `/v1/works/${shortId(target)}/history`
        + `?actingSubject=${encodeURIComponent(f.actor)}`)).status).toBe(404);
    }
    const oldCharacter = retained[1]!;
    const obsoleteReply = nativeId();
    await f.grant(`content:draft:${obsoleteReply}`, 'content.draft');
    expect((await call('POST', '/v1/member-reply-drafts', { ...oldCharacter.input,
      reply: obsoleteReply, variantId: `urn:rezics:variant:${randomUUID()}` })).status).toBe(403);
    await json(await call('POST', '/v1/member-reply-drafts', { ...oldCharacter.input,
      expectedHead: oldCharacter.revisionId, body: 'Edited reply on retained character evidence' }), 201);
    // Write scopes authorize both writes; target authority must not introduce work:read OAuth.
    const fullToken = f.account.tokenA;
    f.account.tokenA = await f.account.tokenFor(f.account.a, 'openid comment:create work:edit');
    const scopedReply = nativeId(), variantId = `urn:rezics:variant:${randomUUID()}`;
    await f.grant(`content:draft:${scopedReply}`, 'content.draft');
    const scopedDraft = await json<{ revisionId: string }>(await call('POST', '/v1/member-reply-drafts', {
      ...oldCharacter.input, reply: scopedReply, variantId, rootRevision: editedCharacter.revision }), 201);
    await json(await call('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply: scopedReply,
      variantId, revisionId: scopedDraft.revisionId, author: f.actor, rootTarget: character.component,
      rootRevision: editedCharacter.revision, parentReply: null, parentRevision: null, contextRevision: null }), 201);
    f.account.tokenA = fullToken;
    expect(await json(await discussion(sao.bunko.work, false))).toMatchObject({ items: [] });
    expect((await discussion(hidden.target, false)).status).toBe(404);
    expect((await discussion(sao.unpublished.work, false)).status).toBe(404);
    expect((await call('POST', '/v1/member-reply-drafts', { profile: 'member-reply-draft-v1',
      reply: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`, rootTarget: hidden.target,
      rootRevision: hidden.revision, language: 'en', direction: 'ltr', expectedHead: null,
      body: 'Anonymous private occurrence reply', actingSubject: f.actor }, false)).status).toBe(401);
    const franchise = nativeId();
    await f.grant(`collection:edit:${franchise}`, 'collection.edit');
    await f.grant(`semantic:read:${franchise}`, 'semantic.read');
    const collection = await json<{ structure: string; revision: string }>(await call('POST', '/v1/collections', {
      collection: franchise, name: 'Sword Art Online franchise', disclosure: 'public', actingSubject: f.actor }), 201);
    await json(await call('POST', `/v1/collections/${shortId(franchise)}/changes`, {
      expectedHead: collection.revision, actingSubject: f.actor,
      operations: [sao.web.work, sao.bunko.work, character.component].map(target => ({
        op: 'insert', parent: collection.structure, position: 'last', role: 'member', target })) }));
    const members = await json<{ occurrences: { target: string; selection?: unknown }[] }>(await call('GET',
      `/v1/collections/${shortId(franchise)}?actingSubject=${encodeURIComponent(f.actor)}`));
    expect(members.occurrences.map(member => member.target)).toEqual([sao.web.work, sao.bunko.work, character.component]);
    expect(members.occurrences.every(member => member.selection === undefined)).toBe(true);
    await f.grant(`rating:context:${realm.realm}`, 'rating.context.create');
    const context = await json<{ context: string }>(await call('POST', '/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm: realm.realm, question: 'How good was it?', actingSubject: f.actor }), 201);
    await f.grant(`rating:observe:${context.context}`, 'rating.observation.set');
    await json(await call('POST', '/v1/rating-observations', { profile: 'realm-standing-rating-observation-v1',
      context: context.context, work: sao.bunko.work, mainVersion: sao.bunko.mainVersion,
      expectedRevisionHead: null, value: 8, actingSubject: f.actor }), 201);
    await json(await call('POST', '/v1/reviews', { profile: 'reader-review-command-v1', actingSubject: reviewer.agent,
      context: context.context, target: sao.bunko.work, expectedRevision: null, language: 'en', text: 'Still a Work review', spoiler: false }), 201);
    expect(await json(await call('GET', `/v1/resources/${shortId(sao.bunko.work)}/reviews?context=${encodeURIComponent(context.context)}`, undefined, false)))
      .toMatchObject({ items: [{ work: sao.bunko.work, rating: 8 }] });
    expect(await json(await call('GET', `/v1/resources/${shortId(sao.bunko.work)}/ratings?scope=realm&realm=${encodeURIComponent(realm.realm)}&context=${encodeURIComponent(context.context)}`, undefined, false)))
      .toMatchObject({ mainVersion: sao.bunko.mainVersion, count: 1, mean: 8 });
    expect(await json(await call('GET', `/v1/resources/${shortId(sao.bunko.work)}/rating-contexts?scope=realm&realm=${encodeURIComponent(realm.realm)}`, undefined, false)))
      .toMatchObject({ items: [{ context: context.context }] });
    expect((await call('GET', `/v1/resources/${shortId(paperback.release)}/reviews?context=${encodeURIComponent(context.context)}`, undefined, false)).status).toBe(422);
    expect((await call('POST', '/v1/reviews', { profile: 'reader-review-command-v1', actingSubject: reviewer.agent,
      context: context.context, target: paperback.release, expectedRevision: null, language: 'en',
      text: 'A release is a future review grain', spoiler: false })).status).toBe(422);
    await f.env.fuseki.update(`INSERT DATA { GRAPH <urn:rezics:graph:revisions> {
      <${chapter.revision}> a <https://rezics.com/vocab/ErasedRevision>
    } }`);
    expect(await json(await discussion(chapter.target))).toMatchObject({ items: [] });
    expect((await call('GET', `/v1/member-replies/${shortId(retained[0]!.input.reply)}`
      + `?actingSubject=${encodeURIComponent(f.actor)}`)).status).toBe(404);
    expect((await call('POST', '/v1/member-reply-drafts', { ...retained[0]!.input,
      expectedHead: retained[0]!.revisionId, body: 'Erased root cannot be edited' })).status).toBe(403);
    expect((await call('GET', `/v1/realms/${shortId(realm.realm)}/threads/${shortId(retained[0]!.input.reply)}`
      + `?actingSubject=${encodeURIComponent(reviewer.agent)}`)).status).toBe(404);
  } finally { await f.close(); rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
