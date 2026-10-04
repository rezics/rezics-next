import { resourceCandidatePattern } from '../../../services/main/src/modules/realm-submission/resource.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { targetRead, resolveTargets } from '../../../services/main/src/modules/target/resolve.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ContentComments } from '../../../services/content/src/comments.ts';
import { StudioAccess } from '../../../services/main/src/modules/studio/access.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { WorkMaintainers } from '../../../services/main/src/modules/work/maintainers.ts';
import { prepareChapterPosts } from '../../../services/main/src/modules/post/backfill.ts';
import { GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { RightsStore, PUBLIC_DOMAIN_TEXT_USE, publicDomainWorkMaterial }
  from '../../../services/main/src/modules/rights/store.ts';
import { startMediaStack } from './media-support.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

test('Posts retain independent custody, shared text and comments, and per-occurrence progress through migration', async () => {
  const stack = await startMediaStack('post-lifecycle', { library: true, agents: true });
  try {
    const members = await Promise.all(['author', 'cowriter', 'reader'].map(name => stack.member(name)));
    const actors = [];
    for (const member of members) {
      const provision = await json<{ agent: string }>(await member.send('POST', '/v1/agents', {
        profile: 'agent-provision-v1', kind: 'person', displayName: member.name }), 201);
      actors.push({ ...member, actor: provision.agent });
    }
    const [author, cowriter, reader] = actors;
    if (!author || !cowriter || !reader) throw new Error('Missing fixture members');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const comments = new ContentComments(stack.contentPool);
    const rights = new RightsStore(stack.contentPool, stack.accessPool);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      structureObjects: objects, content: stack.content, contentAuthoring: stack.content, comments,
      studioAccess: new StudioAccess(stack.accessPool, stack.env.fuseki),
      progress: new StructureProgressStore(stack.contentPool), maintainers: new WorkMaintainers(stack.accessPool, stack.env),
      rights: { store: rights }, account: { verify: async request => {
        const member = actors.find(actor => request.headers.get('authorization') === `Bearer ${actor.token}`);
        if (!member) throw new Error('Unknown bearer');
        const principal = { ...member.principal, emailVerified: true as const };
        return { ...principal, currentAssertion: async () => principal };
      } } });
    const send = (actor: typeof author, method: string, path: string, body?: unknown, key = randomUUID()) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${actor.token}`, 'idempotency-key': key,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const grant = async (actor: typeof author, scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,'infinity')`,
      [randomUUID(), actor.principalId, actor.actor, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES ($1,$2,$2,$3,$4,'infinity')`,
      [randomUUID(), actor.actor, scope, action]);
    };
    const book = async (title: string) => {
      const work = await json<{ work: string; mainVersion: string }>(await send(author, 'POST', '/v1/works', {
        profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
        semanticTypes: ['https://schema.org/Book'], actingSubject: author.actor }), 201);
      const text = await stack.contribution(work.work, author.actor, 'en', `${title} opening`);
      const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
        contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: author.actor };
      await selectMainDefault(stack.env, stack.admission(author.actor, `publication:select:${work.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      const structure = await json<{ structure: string; revision: string }>(await send(author, 'POST', '/v1/compositions', {
        profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: author.actor }), 201);
      return { ...work, ...structure };
    };
    const firstBook = await book('Shared serial'), secondBook = await book('Second serial');
    await grant(cowriter, `work:edit:${firstBook.work}`, 'work.edit');
    const body = { profile: 'book-chapter-create-v1', title: 'Opening chapter', language: 'en', direction: 'ltr',
      parent: firstBook.structure, position: 'last', expectedCompositionHead: firstBook.revision, actingSubject: author.actor };
    const createKey = randomUUID();
    const first = await json<{ post: string; revision: string; variantId: string; occurrence: string;
      compositionRevision: string; receipt: string }>(await send(author, 'POST', `/v1/works/${short(firstBook.work)}/chapters`, body, createKey));
    const second = await json<typeof first>(await send(cowriter, 'POST', `/v1/works/${short(firstBook.work)}/chapters`, {
      ...body, title: 'Cowriter chapter', expectedCompositionHead: first.compositionRevision, actingSubject: cowriter.actor }));
    const draft = (post: typeof first, actor = author, expectedHead: string | null = null) => send(actor, 'POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: post.post, variantId: post.variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead,
      body: 'One shared paragraph.', actingSubject: actor.actor });
    expect((await draft(first, cowriter)).status).toBe(403);
    expect((await draft(second, author)).status).toBe(403);
    await json(await draft(second, cowriter), 201);
    const saved = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(await draft(first), 201);
    const publication = await json<{ decision: string; status: string }>(await send(author, 'POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `post-${randomUUID()}`, revisionId: saved.revisionId,
      expectedDigest: saved.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
      resourceId: first.post, variantId: first.variantId, expectedPublicationHead: null, actingSubject: author.actor }), 201);
    expect(publication.status).toBe('active');
    await json(await send(author, 'POST', '/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
      resourceId: first.post, variantId: first.variantId, publicationDecision: publication.decision,
      expectedEligibilityHead: null, actingSubject: author.actor, rightsBasis: 'original-contribution', disclosure: 'public' }), 201);
    const inserted = await json<{ occurrences: string[] }>(await send(author, 'POST',
      `/v1/compositions/${short(secondBook.structure)}/changes`, { profile: 'book-composition',
        expectedHead: secondBook.revision, actingSubject: author.actor, operations: [{ op: 'insert',
          role: 'chapter', target: first.post, parent: secondBook.structure, position: 'last',
          label: { value: 'Reused opening', language: 'en' } }] }));
    const comment = await json<{ comment: string; resourceId: string }>(await send(reader, 'POST', '/v1/content-comments', {
      profile: 'content-paragraph-comment-v1', resourceId: first.post, revisionId: saved.revisionId,
      exact: 'One shared paragraph.', body: 'A reader comment', actingSubject: reader.actor }), 201);
    const progressPath = (structure: string, occurrence: string) => `/v1/compositions/${short(structure)}/occurrences/${short(occurrence)}/progress`;
    const progress = { actingSubject: reader.actor, selectedRevision: `urn:rezics:content:revision:${saved.revisionId}`,
      expectedVersion: 0, completed: true, position: null };
    await json(await send(reader, 'PUT', progressPath(firstBook.structure, first.occurrence), progress));
    expect(await json(await send(reader, 'GET', `${progressPath(secondBook.structure, inserted.occurrences[0]!)}?actingSubject=${encodeURIComponent(reader.actor)}&selectedRevision=${encodeURIComponent(progress.selectedRevision)}`)))
      .toMatchObject({ completed: false, version: 0 });
    expect(await json(await send(reader, 'GET', `/v1/posts/${short(first.post)}?actingSubject=${encodeURIComponent(reader.actor)}`))).toMatchObject({ id: first.post, publisher: author.actor });
    expect(await targetRead(stack.env, { access: stack.access }, session => resolveTargets(session, [first.post], 'suitability')))
      .toMatchObject([{ resource: first.post, base: 'resource', work: null, types: ['https://rezics.com/vocab/Post'] }]);
    const spaceInput = { name: 'Post Realm', capabilities: ['realm' as const], actingSubject: author.actor };
    const realm = await createRealmSpace(stack.env, stack.admission(author.actor, 'space:create:root', 'space.create',
      spaceCreationDigest(spaceInput)), spaceInput);
    if (!realm.realm) throw new Error('Missing fixture Realm');
    const offered = { kind: 'content-publication' as const, actingSubject: author.actor, work: first.post,
      mainVersion: firstBook.mainVersion, workRevision: first.revision, variant: first.variantId,
      publicationDecision: publication.decision, contentRevision: saved.revisionId };
    expect((await stack.env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      ${resourceCandidatePattern(realm.realm, offered)} }`)).boolean).toBe(true);
    await grant(author, 'rights:assess', 'rights.assess');
    const assessment = await rights.assess({ ...author.principal, emailVerified: true }, { actingSubject: author.actor,
      material: publicDomainWorkMaterial(first.post), expressionKind: 'expression', ...PUBLIC_DOMAIN_TEXT_USE,
      basis: 'public_domain', outcome: 'supported', licenseInstrument: null, exceptionKind: null, rationale: null,
      extent: {}, evidence: { fixture: true }, obligations: [], expectedAssessment: null, idempotencyKey: randomUUID() });
    // Older command receipts retain their immutable names; replay still returns the Post.
    const legacyMain = `https://rezics.com/id/${randomUUID()}`;
    const legacyRevision = `https://rezics.com/id/${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.receipts)} { ${iri(first.receipt)} rv:post ${iri(first.post)} ;
        rv:postRevision ${iri(first.revision)} . } }
      INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(first.receipt)} rv:chapterWork ${iri(first.post)} ;
        rv:chapterWorkRevision ${iri(first.revision)} ; rv:chapterMainVersion ${iri(legacyMain)} ;
        rv:chapterMainRevision ${iri(legacyRevision)} . } }
      WHERE { GRAPH ${iri(GRAPHS.receipts)} { ${iri(first.receipt)} rv:post ${iri(first.post)} . } }`);
    expect(await json(await send(author, 'POST', `/v1/works/${short(firstBook.work)}/chapters`, body, createKey)))
      .toMatchObject({ post: first.post, revision: first.revision, replayed: true });
    await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(first.post)} a rv:Post ; rv:publisher ?publisher . } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(first.post)} a schema:CreativeWork ;
        rv:mainVersion ${iri(legacyMain)} ; schema:isPartOf ${iri(firstBook.work)} .
        ${iri(legacyMain)} a rv:MainVersion ; rv:work ${iri(first.post)} ; rv:hostingPolicy rv:MetadataOnly . } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(first.post)} rv:publisher ?publisher . } }`);
    const ownerRows = (await stack.accessPool.query('SELECT * FROM access.work_maintainer_set WHERE work=$1', [first.post])).rows;
    const history = await stack.fuseki.query(`SELECT (COUNT(*) AS ?count) WHERE { GRAPH ${iri(GRAPHS.revisions)} { ?s ?p ?o } }`);
    expect(await prepareChapterPosts(stack.env, stack.accessPool)).toBe(1);
    expect(await prepareChapterPosts(stack.env, stack.accessPool)).toBe(0);
    expect((await stack.accessPool.query('SELECT * FROM access.work_maintainer_set WHERE work=$1', [first.post])).rows).toEqual(ownerRows);
    expect(await stack.fuseki.query(`SELECT (COUNT(*) AS ?count) WHERE { GRAPH ${iri(GRAPHS.revisions)} { ?s ?p ?o } }`)).toEqual(history);
    expect((await stack.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0]?.status).toBe('available');
    expect(await comments.read(comment.comment.slice(-36))).toMatchObject({ resourceId: first.post, revisionId: saved.revisionId });
    expect(await rights.currentPublicDomainAssessment(first.post, assessment.assessmentId)).toBe(true);
    expect(await json(await send(reader, 'GET', `${progressPath(firstBook.structure, first.occurrence)}?actingSubject=${encodeURIComponent(reader.actor)}&selectedRevision=${encodeURIComponent(progress.selectedRevision)}`)))
      .toMatchObject({ completed: true, version: 1 });
    expect((await stack.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} { ${iri(legacyMain)} ?p ?o } }`)).boolean).toBe(false);
    await json(await send(author, 'POST', '/v1/work-maintainer-changes', { profile: 'work-maintainer-change-v1',
      work: firstBook.work, actingSubject: author.actor, target: cowriter.actor, action: 'transfer', expectedGeneration: '0' }), 201);
    expect((await draft(first, author, saved.revisionId)).status).toBe(201);
    expect((await draft(first, cowriter, saved.revisionId)).status).toBe(403);
  } finally { await stack.stop(); }
}, 240_000);
