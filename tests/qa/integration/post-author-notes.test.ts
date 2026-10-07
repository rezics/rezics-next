import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { startMediaStack } from './media-support.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { activateMetadataWork, metadataWorkRequestDigest, GRAPHS, RV, iri }
  from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
import { manuscriptLength } from '../../../services/main/src/modules/studio/chapters.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { feedSources } from '../../../services/main/src/modules/feed/source.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { readFixedRelease } from '../../../services/main/src/modules/work/fixed-release.ts';
import type { PostNotesInput, PostNotes } from '../../../services/content/src/document-body.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';

const short = (value: string) => value.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
interface Draft { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }

test('Post notes stay language-local on exact chapter reads and outside length, search, feed and fixed releases', async () => {
  const stack = await startMediaStack('post-author-notes', { contentProjection: true });
  try {
    const author = await stack.member('notes-author');
    const stranger = await stack.member('notes-stranger');
    await stack.contentCursor.initialize(stack.contentConsumer);
    const title = `Notes Book ${randomUUID()}`;
    const types = ['https://schema.org/Book'];
    const book = await activateMetadataWork(stack.env, { title, language: 'en', semanticTypes: types,
      admission: stack.admission(author.actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(title, types, 'en')) });
    const bookText = 'The text of the fixed Work release.';
    const contribution = await stack.contribution(book.work, author.actor, 'en', bookText);
    const selected = { context: { kind: 'main-version-default' as const, id: book.mainVersion },
      work: book.work, contribution: contribution.contribution, publicationDecision: contribution.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: author.actor };
    await selectMainDefault(stack.env, stack.admission(author.actor, `publication:select:${book.mainVersion}`,
      'publication.select', mainSelectionDigest(selected)), selected);
    await author.grant(`work:edit:${book.work}`, 'work.edit');
    await author.grant(`work:read:${book.work}`, 'work.read');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    Object.assign(stack.env, { structureObjects: objects });
    const composition = await json<{ structure: string; revision: string }>(await author.send('POST', '/v1/compositions', {
      profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: author.actor }), 201);
    const chapter = await json<{ post: string; variantId: string; occurrence: string }>(await author.send('POST',
      `/v1/works/${short(book.work)}/chapters`, { profile: 'book-chapter-create-v1', title: 'Opening',
        language: 'en', direction: 'ltr', parent: composition.structure, position: 'last',
        expectedCompositionHead: composition.revision, actingSubject: author.actor }));
    for (const [scope, action] of [['work:read', 'work.read'], ['content:draft', 'content.draft'],
      ['content:publish', 'content.publish'], ['content:search-eligibility', 'content.search-eligibility']] as const) {
      await author.grant(`${scope}:${chapter.post}`, action);
    }
    const marker = `PrivateNote${randomUUID().replaceAll('-', '')}`;
    const variants: Array<{ language: string; body: string; notes?: PostNotesInput }> = [
      { language: 'en', body: 'A lantern lights the road.', notes: {
        before: { document: fromPlainText(`${marker} before the chapter`) },
        after: { body: `${marker} after the chapter` } } },
      { language: 'ja', body: '灯りが道を照らす。', notes: { after: { document: fromPlainText('翻訳者の後書き') } } },
      { language: 'fr', body: 'Une lanterne éclaire la route.' },
    ];
    const published: Array<{ draft: Draft; variant: string; eligibility: string }> = [];
    for (const [index, item] of variants.entries()) {
      const variant = index === 0 ? chapter.variantId : `urn:rezics:variant:${randomUUID()}`;
      const request = { profile: 'content-text-v1', resourceId: chapter.post, variantId: variant,
        language: { kind: 'tag', tag: item.language, originalTag: item.language }, direction: 'ltr',
        expectedHead: null, document: fromPlainText(item.body), notes: item.notes, actingSubject: author.actor };
      const key = randomUUID();
      const draft: Draft = await json<Draft>(await author.send('POST', '/v1/content-drafts', request, key), 201);
      expect(await json(await author.send('POST', '/v1/content-drafts', request, key)))
        .toMatchObject({ revisionId: draft.revisionId, replayed: true });
      const publicationInput = { profile: 'content-publication-v1', preparationId: `notes-${randomUUID()}`,
        revisionId: draft.revisionId, expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
        resourceId: chapter.post, variantId: variant, expectedPublicationHead: null, actingSubject: author.actor };
      const publishKey = randomUUID();
      const publication = await json<{ decision: string; status: string }>(await author.send('POST',
        '/v1/content-publications', publicationInput, publishKey), 201);
      expect(publication.status).toBe('active');
      expect(await json(await author.send('POST', '/v1/content-publications', publicationInput, publishKey)))
        .toMatchObject({ decision: publication.decision, replayed: true });
      const eligibility = await json<{ decision: string }>(await author.send('POST', '/v1/content-search-eligibility', {
        profile: 'content-search-eligibility-v1', resourceId: chapter.post, variantId: variant,
        publicationDecision: publication.decision, expectedEligibilityHead: null, actingSubject: author.actor,
        rightsBasis: 'original-contribution', disclosure: 'public' }), 201);
      published.push({ draft, variant, eligibility: eligibility.decision });
      const before = stack.fuseki.queries;
      const read = await json<{ language: string; content: { reference: { model: string }; body: {
        body: string; document: unknown; notes?: PostNotes } } }>(await stack.call('GET',
        `/v1/chapters/${short(chapter.occurrence)}?language=${item.language}`));
      expect(stack.fuseki.queries - before).toBeLessThanOrEqual(64);
      expect(read.language).toBe(item.language);
      expect(read.content.body.body).toBe(item.body);
      expect(read.content.body.document).toEqual(request.document);
      expect(read.content.reference.model).toBe(item.notes ? 'content-shape-v2' : 'content-shape-v1');
      expect(read.content.body.notes).toEqual(item.notes ? Object.fromEntries(Object.entries(item.notes)
        .map(([key, note]) => [key, note.document ? { body: key === 'before'
          ? `${marker} before the chapter` : '翻訳者の後書き', document: note.document } : note])) : undefined);
      expect(manuscriptLength(read.content.body, item.language)).toEqual(manuscriptLength({ body: item.body }, item.language));
    }
    expect((await stack.call('GET', `/v1/chapters/${short(chapter.occurrence)}?language=de`)).status).toBe(404);
    const en = published[0]!;
    const baseDraft = { profile: 'content-text-v1', resourceId: chapter.post, variantId: en.variant,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: en.draft.revisionId, body: variants[0]!.body, notes: { after: { body: 'Changed note' } },
      actingSubject: author.actor };
    expect((await stranger.send('POST', '/v1/content-drafts', { ...baseDraft, actingSubject: stranger.actor })).status).toBe(403);
    // A note edit uses the same CAS as text; one concurrent edit wins and one retains a stale outcome.
    const results = await Promise.all(['First note', 'Second note'].map(body => author.send('POST',
      '/v1/content-drafts', { ...baseDraft, notes: { after: { body } } })));
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    // Draft note edits do not alter the pinned public revision.
    expect(await json(await stack.call('GET', `/v1/chapters/${short(chapter.occurrence)}?language=en`)))
      .toMatchObject({ content: { body: { notes: { before: { body: `${marker} before the chapter` } } } } });
    await author.grant(`content:draft:${book.work}`, 'content.draft');
    expect((await author.send('POST', '/v1/content-drafts', { ...baseDraft, resourceId: book.work,
      variantId: `urn:rezics:variant:${randomUUID()}`, expectedHead: null })).status).toBe(409);
    expect((await author.send('POST', '/v1/member-reply-drafts', { profile: 'member-reply-draft-v1',
      reply: `https://rezics.com/id/${randomUUID()}`, variantId: `urn:rezics:variant:${randomUUID()}`,
      rootTarget: book.work, rootRevision: book.workRevision, expectedHead: null,
      language: 'en', direction: 'ltr', originRealm: null,
      body: 'Reply text', notes: { before: { body: marker } }, actingSubject: author.actor })).status).toBe(400);

    const command = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!, Bun.env.FUSEKI_COMMAND_TOKEN!);
    const relayEnv = { ...stack.env, fuseki: command };
    const cut = await stack.content.ownerPosition();
    for (let i = 0; i < 20 && (await stack.contentCursor.read(stack.contentConsumer)).sequence !== cut.sequence; i++) {
      if (!await relayContentProjectionOnce(relayEnv, stack.content, stack.contentCursor, stack.contentConsumer)) {
        throw new Error('Content relay stopped before the source cut');
      }
    }
    expect((await stack.contentCursor.read(stack.contentConsumer)).sequence).toBe(cut.sequence);
    const phrase = async (text: string) => json<{ total: number }>(await stack.call('POST', '/v1/queries/page', {
      body: { profile: 'public-main-phrase-page-v1', phrase: text, language: null, pageSize: 10 } }));
    expect((await phrase('lantern lights')).total).toBe(1);
    expect((await phrase(marker)).total).toBe(0);
    const sources = await workRead({ environment: stack.env, access: stack.access, content: stack.content,
      account: { verify: async () => author.principal } }, new Request('http://main.local'), {},
    session => feedSources(session, { ids: [en.eligibility] }));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.excerpt).toBe(variants[0]!.body);

    // Fixed Work releases pin the Work's contribution, never Post augmentations.
    await author.grant(`release:seal:${book.mainVersion}`, 'release.seal');
    await grantRecordedPlatformUse(stack.accessPool, author.principalId, ['commerce']);
    const heads = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?selection WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(book.mainVersion)} rv:head ?head ; rv:selectionHead ?selection } }`))
      .results!.bindings[0]!;
    const fixed = await json<{ release: string }>(await author.send('POST', '/v1/fixed-releases', {
      profile: 'fixed-native-text-release-v1', work: book.work, mainVersion: book.mainVersion,
      expectedMainRevision: heads.head!.value, expectedSelection: heads.selection!.value, actingSubject: author.actor }), 201);
    const release = await readFixedRelease(stack.env, fixed.release, async () => true);
    expect(release.body).toBe(bookText);
    expect(JSON.stringify(release)).not.toContain(marker);
    expect(release).not.toHaveProperty('notes');
  } finally { await stack.stop(); }
}, 240_000);

test('Post spoiler publication and reply draft declarations survive exact storage, omission, explicit false and reads', async () => {
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const { RealmReplyContentStore } = await import('../../../services/main/src/modules/realm-reply/content-store.ts');
  const { RealmReplyStore } = await import('../../../services/main/src/modules/realm-reply/store.ts');
  const stack = await startMediaStack('post-spoiler');
  try {
    const author = await stack.member('spoiler-author');
    const title = `Spoiler Book ${randomUUID()}`;
    const types = ['https://schema.org/Book'];
    const root = await activateMetadataWork(stack.env, { title, language: 'en', semanticTypes: types,
      admission: stack.admission(author.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types, 'en')) });
    const contribution = await stack.contribution(root.work, author.actor, 'en', 'Public Book words');
    const selection = { context: { kind: 'main-version-default' as const, id: root.mainVersion },
      work: root.work, contribution: contribution.contribution, publicationDecision: contribution.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: author.actor };
    await selectMainDefault(stack.env, stack.admission(author.actor, `publication:select:${root.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection);
    const replies = new RealmReplyStore(new RealmReplyContentStore(stack.contentPool), stack.content, stack.access, stack.env);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      content: stack.content, contentAuthoring: stack.content, realmReplies: replies,
      account: { verify: async () => author.principal },
      platformAccess: new AccessExposure(stack.accessPool) });
    const call = (method: string, path: string, body?: object, key = randomUUID()) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: 'Bearer fixture', 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    await author.grant(`reply:create:${root.work}`, 'reply.create');
    const payload = { 'rv:work': [root.work], 'schema:name': [{ '@value': 'A linked Work', '@language': 'en' }] };
    for (const spoiler of [undefined, false, true]) {
      const reply = `https://rezics.com/id/${randomUUID()}`;
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      await author.grant(`content:draft:${reply}`, 'content.draft');
      const document = structuredClone(fromPlainText('Reply words', 'blocks'));
      document.doc.content!.push({ type: 'extensionBlock', attrs: { id: 'reference',
        lang: null, dir: null,
        definition: 'https://rezics.com/definition/work-reference-block-v1', version: spoiler === false ? '2' : '1',
        payload: spoiler === false ? { unknown: [null, { preserved: true }] } : payload,
        fallback: 'A linked Work' } });
      const request = { profile: 'member-reply-draft-v1', reply, variantId, rootTarget: root.work,
        rootRevision: root.workRevision, expectedHead: null, language: 'en', direction: 'ltr',
        document, actingSubject: author.actor, ...(spoiler !== undefined ? { spoiler } : {}) };
      const key = randomUUID();
      const draft = await json<{ revisionId: string }>(await call('POST', '/v1/member-reply-drafts', request, key), 201);
      expect(await json(await call('POST', '/v1/member-reply-drafts', request, key)))
        .toMatchObject({ revisionId: draft.revisionId, replayed: true });
      const identity = { profile: 'realm-reply-identity-v1', reply, variantId, revisionId: draft.revisionId,
        author: author.actor, rootTarget: root.work, rootRevision: root.workRevision,
        parentReply: null, parentRevision: null, contextRevision: null, ...(spoiler !== undefined ? { spoiler } : {}) };
      const published = await json<{ spoiler?: boolean }>(await call('POST', '/v1/realm-replies', identity), 201);
      expect(published.spoiler).toBe(spoiler);
      const read = await json<{ spoiler?: boolean; document: unknown }>(await call('GET', `/v1/member-replies/${short(reply)}`));
      expect(read.spoiler).toBe(spoiler);
      expect(Object.hasOwn(read, 'spoiler')).toBe(spoiler !== undefined);
      expect(read.document).toEqual(document);
      const edits = [{ ...request, document: undefined, body: 'A simple edit', expectedHead: draft.revisionId, spoiler: undefined },
        { ...request, document: undefined, body: 'Explicitly safe', expectedHead: '', spoiler: false }];
      for (const edit of edits) {
        const saved = await json<{ revisionId: string }>(await call('POST', '/v1/member-reply-drafts', edit), 201);
        const current = await json<{ spoiler?: boolean }>(await call('GET', `/v1/member-replies/${short(reply)}`));
        expect(current.spoiler).toBe(edit.spoiler === undefined ? spoiler : false);
        edits[1]!.expectedHead = saved.revisionId;
      }
    }
    const page = await json<{ items: { spoiler?: boolean }[] }>(await call('GET',
      `/v1/member-replies?rootTarget=${encodeURIComponent(root.work)}&rootRevision=${encodeURIComponent(root.workRevision)}`));
    expect(page.items).toHaveLength(3);
    expect(page.items.every(item => item.spoiler === false)).toBe(true);

    // The same Post profile changes in place; publishing another language with
    // an omitted declaration must preserve the author's existing choice.
    await author.grant(`work:edit:${root.work}`, 'work.edit');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    Object.assign(stack.env, { structureObjects: objects });
    const composition = await json<{ structure: string; revision: string }>(await author.send('POST', '/v1/compositions', {
      profile: 'book-composition', work: root.work, mainVersion: root.mainVersion, actingSubject: author.actor }), 201);
    const chapter = await json<{ post: string; variantId: string }>(await author.send('POST', `/v1/works/${short(root.work)}/chapters`, {
      profile: 'book-chapter-create-v1', title: 'Spoiler chapter', language: 'en', direction: 'ltr', parent: composition.structure,
      position: 'last', expectedCompositionHead: composition.revision, actingSubject: author.actor }));
    await author.grant(`work:read:${chapter.post}`, 'work.read');
    await author.grant(`content:draft:${chapter.post}`, 'content.draft');
    await author.grant(`content:publish:${chapter.post}`, 'content.publish');
    let head: string | null = null;
    let publicationHead: string | null = null;
    for (const spoiler of [true, undefined, false]) {
      const draft: Draft = await json<Draft>(await author.send('POST', '/v1/content-drafts', { profile: 'content-text-v1',
        resourceId: chapter.post, variantId: chapter.variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr', expectedHead: head, body: 'Chapter words', actingSubject: author.actor }), 201);
      const published: { status: string; decision: string } = await json<{ status: string; decision: string }>(await author.send('POST', '/v1/content-publications', {
        profile: 'content-publication-v1', preparationId: randomUUID(), revisionId: draft.revisionId,
        expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch, resourceId: chapter.post,
        variantId: chapter.variantId, expectedPublicationHead: publicationHead, actingSubject: author.actor,
        ...(spoiler !== undefined ? { spoiler } : {}) }), 201);
      expect(published.status).toBe('active');
      expect(await json(await author.read(`/v1/posts/${short(chapter.post)}`))).toMatchObject({ spoiler: spoiler ?? true });
      head = draft.revisionId;
      publicationHead = published.decision;
    }
    // The current head is active text. Without public search eligibility the
    // shared projection consumer defers it and never reaches the owner head.
    if (!publicationHead) throw new Error('spoiler publication missing');
    await author.grant(`content:search-eligibility:${chapter.post}`, 'content.search-eligibility');
    await json(await author.send('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: chapter.post, variantId: chapter.variantId,
      publicationDecision: publicationHead, expectedEligibilityHead: null, actingSubject: author.actor,
      rightsBasis: 'original-contribution', disclosure: 'public',
    }), 201);
    const command = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!, Bun.env.FUSEKI_COMMAND_TOKEN!);
    const receipt = `urn:rezics:receipt:${randomUUID()}`;
    await expect(command.command({ receipt, digest: 'a'.repeat(64),
      update: `PREFIX rv: <${RV}> INSERT {
        GRAPH ${iri(GRAPHS.current)} { ${iri(chapter.post)} rv:spoiler true }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest "${'a'.repeat(64)}" }
      } WHERE { FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } }`,
      validations: [{ profile: 'post-v1', sha256: profileRegistry['post-v1'].sha256,
        shape: 'https://rezics.com/definition/post-v1/post-shape', focus: [], graphs: [GRAPHS.current],
        binding: { post: chapter.post, publisher: author.actor, revision: root.workRevision } }], deadlineMs: 10_000 }))
      .rejects.toThrow('invalid IRI list');
    expect(await json(await author.read(`/v1/posts/${short(chapter.post)}`))).toMatchObject({ spoiler: false });
  } finally { await stack.stop(); }
}, 180_000);
