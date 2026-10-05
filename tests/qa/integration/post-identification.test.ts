import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { PostIdentifications } from '../../../services/main/src/modules/post/identification-store.ts';
import { GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';
import { readCurrentOccurrence, readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { GLOBAL_CONTEXT_ID, GLOBAL_CONTEXT_SCOPE, GLOBAL_OBSERVATION_ID } from '../../../services/main/src/modules/rating/global.ts';
import { startMediaStack } from './media-support.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { indexedLabels } from '../../../services/main/src/modules/search/labels.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
type Work = { work: string; mainVersion: string };
type Structure = { structure: string; revision: string };
type Post = { post: string; variantId: string; occurrence: string; compositionRevision: string };
type Identification = Work & Structure & { identification: string; post: string; occurrence: string;
  relation: string; relationRevision: string; receipt: string; replayed: boolean };

test('A writer identifies one Post as a Work without moving text, custody, discussion or Book occurrences', async () => {
  const stack = await startMediaStack('post-identification', { library: true, agents: true });
  try {
    const actors = [];
    for (const name of ['writer', 'maintainer', 'stranger']) {
      const member = await stack.member(name);
      const provision = await json<{ agent: string }>(await member.send('POST', '/v1/agents', {
        profile: 'agent-provision-v1', kind: 'person', displayName: member.name }), 201);
      actors.push({ ...member, actor: provision.agent });
    }
    const [writer, maintainer, stranger] = actors;
    if (!writer || !maintainer || !stranger) throw new Error('Missing fixture members');
    const objects = stack.objects('semantic/structure/'); await objects.initialize();
    class LostCheckpoint extends PostIdentifications {
      losePlacement = false;
      override async checkpoint<T>(id: string, step: string, value: T): Promise<T> {
        if (this.losePlacement && step === 'placement') { this.losePlacement = false; throw new Error('Lost placement response'); }
        return super.checkpoint(id, step, value);
      }
    }
    const store = new LostCheckpoint(stack.accessPool);
    const dependencies: MainWorkDependencies = { environment: stack.env, access: stack.access,
      structureObjects: objects, content: stack.content, contentAuthoring: stack.content,
      follows: new FollowsStore(stack.accessPool), reviews: new ReaderReviews(stack.accessPool),
      postIdentifications: store, account: { verify: async request => {
        const actor = actors.find(value => request.headers.get('authorization') === `Bearer ${value.token}`);
        if (!actor) throw new Error('Unknown bearer');
        const principal = { ...actor.principal, emailVerified: true as const };
        return { ...principal, currentAssertion: async () => principal };
      } } };
    const app = createMainApp(stack.fuseki, dependencies);
    const send = (actor: typeof writer, method: string, path: string, body?: unknown, key = randomUUID()) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${actor.token}`, 'idempotency-key': key,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const publicGet = (path: string) => app.handle(new Request(`http://main.local${path}`));
    const grant = async (actor: typeof writer, scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation
        (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,$4,'infinity')`,
      [randomUUID(), actor.principalId, actor.actor, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until) VALUES ($1,$2,$2,$3,$4,'infinity')`,
      [randomUUID(), actor.actor, scope, action]);
    };
    let definition = await readDefinitionByKey(stack.env, 'composition-part');
    if (!definition) {
      await grant(writer, 'semantic:create:root', 'semantic.change');
      await json(await send(writer, 'POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1', expectedHead: null, actingSubject: writer.actor,
        state: { component: 'definition', kind: 'relation', notation: 'composition-part', workSubjectRole: 'part',
          roles: ['whole', 'part'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) },
      }), 201);
      definition = await readDefinitionByKey(stack.env, 'composition-part');
    }
    if (!definition) throw new Error('Missing composition-part definition');
    for (const actor of actors) await grant(actor, `semantic:read:${definition.definition}`, 'semantic.read');
    const createWork = async (actor: typeof writer, title: string, type = 'https://schema.org/Book') =>
      json<Work>(await send(actor, 'POST', '/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work',
        title, language: 'en', semanticTypes: [type], actingSubject: actor.actor }), 201);
    const book = await createWork(maintainer, 'Stories from the coast');
    const structure = await json<Structure>(await send(maintainer, 'POST', '/v1/compositions', {
      profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: maintainer.actor }), 201);
    await grant(writer, `work:edit:${book.work}`, 'work.edit');
    const post = await json<Post>(await send(writer, 'POST', `/v1/works/${short(book.work)}/chapters`, {
      profile: 'book-chapter-create-v1', title: 'One coastal story', language: 'en', direction: 'ltr',
      parent: structure.structure, position: 'last', expectedCompositionHead: structure.revision, actingSubject: writer.actor }));
    const draft = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      await send(writer, 'POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: post.post,
        variantId: post.variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        expectedHead: null, body: 'The coastal story stands on its own.', actingSubject: writer.actor }), 201);
    const publication = await json<{ decision: string }>(await send(writer, 'POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `identify-${randomUUID()}`, revisionId: draft.revisionId,
      expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
      resourceId: post.post, variantId: post.variantId, expectedPublicationHead: null, actingSubject: writer.actor }), 201);
    await json(await send(writer, 'POST', '/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
      resourceId: post.post, variantId: post.variantId, publicationDecision: publication.decision,
      expectedEligibilityHead: null, actingSubject: writer.actor, rightsBasis: 'original-contribution', disclosure: 'public' }), 201);
    // Publishing grants no maintainer custody over somebody else's Post.
    expect(await stack.access.canEditWork({ ...maintainer.principal, emailVerified: true,
      currentAssertion: async () => ({ ...maintainer.principal, emailVerified: true }) }, maintainer.actor, post.post)).toBe(false);
    const snapshot = async () => (await stack.fuseki.query(`SELECT ?s ?p ?o WHERE {
      GRAPH ${iri(GRAPHS.current)} { VALUES ?s { ${[book.work, book.mainVersion, structure.structure, post.post, post.variantId].map(iri).join(' ')} }
        ?s ?p ?o } } ORDER BY ?s ?p ?o`)).results!.bindings;
    const before = await snapshot();
    const intent = { profile: 'post-identification-v1', placement: { book: book.work, occurrence: post.occurrence },
      evidence: { kind: 'independent-citation', source: { kind: 'citation', value: 'Coastal Anthology, story 2' } },
      work: { kind: 'new', type: 'https://schema.org/DigitalDocument', titles: [
        { language: 'en', value: 'Coastal lantern' }, { language: 'hi', value: 'तट का दीपक' },
        { language: 'zh-Hans', value: '海边的灯' }] }, actingSubject: writer.actor };
    const path = `/v1/posts/${short(post.post)}/identifications`, key = randomUUID();
    expect((await send(stranger, 'POST', path, { ...intent, actingSubject: stranger.actor })).status).toBe(403);
    expect((await stack.accessPool.query('SELECT id FROM access.post_identification WHERE post=$1', [post.post])).rowCount).toBe(0);
    store.losePlacement = true;
    expect((await send(writer, 'POST', path, intent, key)).status).toBe(202);
    const identified = await json<Identification>(await send(writer, 'POST', path, intent, key));
    expect(identified.post).toBe(post.post);
    expect(identified.work).not.toBe(post.post);
    expect(await snapshot()).toEqual(before);
    const replay = await json<Identification>(await send(writer, 'POST', path, intent, key));
    expect(replay).toMatchObject({ work: identified.work, relation: identified.relation, receipt: identified.receipt, replayed: true });
    expect((await send(writer, 'POST', path, { ...intent, evidence: { kind: 'standalone-title' } }, key)).status).toBe(409);
    const retained = await readCurrentOccurrence(stack.env, identified.relation);
    expect(retained?.state.evidence).toBe(identified.receipt);
    expect(retained?.state.participations.map(item => item.participant)).toEqual(expect.arrayContaining([
      { kind: 'resource', ref: book.work }, { kind: 'resource', ref: identified.work }]));
    const workPage = await json<{ disclosure: string; title: { value: string }; types: string[] }>(
      await publicGet(`/v1/works/${short(identified.work)}?language=zh-Hans`));
    expect(workPage).toMatchObject({ disclosure: 'public', title: { value: '海边的灯' }, types: ['https://schema.org/DigitalDocument'] });
    const links = await json<{ items: Array<{ title: { value: string } }> }>(await publicGet(`${path}?language=zh-Hans`));
    expect(links.items[0]?.title.value).toBe('海边的灯');
    const chapter = await json<{ content: { body: Record<string, unknown> }; target: string }>(
      await publicGet(`/v1/chapters/${short(identified.occurrence)}?language=en`));
    expect(JSON.stringify(chapter)).toContain('The coastal story stands on its own.');
    const contents = await json<{ items: Array<{ occurrence: string }> }>(
      await publicGet(`/v1/works/${short(identified.work)}/contents?language=en`));
    expect(contents.items.map(item => item.occurrence)).toEqual([identified.occurrence]);
    const names = await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <urn:rezics:search:public> {
      ?unit a rv:PublicNameMatchUnit ; rv:resource ${iri(identified.work)} ; rv:publicTitle "Coastal lantern"@en } }`);
    expect(names.boolean).toBe(true);
    const searched = await workRead(dependencies, new Request('http://main.local/v1/query'), {},
      session => indexedLabels(session, 'Coastal lantern', 20, undefined, 'work'));
    expect(searched.ids).toContain(identified.work);
    await grant(writer, GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const context = await json<{ context: string }>(await send(writer, 'POST', '/v1/global-rating-contexts', {
      profile: GLOBAL_CONTEXT_ID, question: 'How much did you enjoy this Work?', actingSubject: writer.actor }), 201);
    await grant(stranger, `rating:observe:${context.context}`, 'rating.observation.set');
    const rating = await json<{ work: string; value: number }>(await send(stranger, 'POST', '/v1/global-rating-observations', {
      profile: GLOBAL_OBSERVATION_ID, context: context.context, work: identified.work, mainVersion: identified.mainVersion,
      expectedRevisionHead: null, value: 4, actingSubject: stranger.actor }), 201);
    expect(rating).toMatchObject({ work: identified.work, value: 4 });
    const followed = await json<{ target: string; kind: string; following: boolean }>(await send(stranger, 'POST', '/v1/follows', {
      profile: 'follow-command-v1', target: identified.work, kind: 'work', actingSubject: stranger.actor,
      following: true, expectedRevision: null }));
    expect(followed).toMatchObject({ target: identified.work, kind: 'work', following: true });
    const reviewed = await json<{ review: string }>(await send(stranger, 'POST', '/v1/reviews', {
      profile: 'reader-review-command-v1', context: context.context, target: identified.work,
      actingSubject: stranger.actor, expectedRevision: null, language: 'en', text: 'A complete story in one chapter.', spoiler: false }), 201);
    const review = await json<{ work: string; text: string }>(await publicGet(`/v1/reviews/${reviewed.review}`));
    expect(review).toMatchObject({ work: identified.work, text: 'A complete story in one chapter.' });
    const existing = await createWork(maintainer, 'The separately published story');
    await json(await send(maintainer, 'POST', '/v1/compositions', { profile: 'book-composition',
      work: existing.work, mainVersion: existing.mainVersion, actingSubject: maintainer.actor }), 201);
    const existingIntent = { ...intent, work: { kind: 'existing', id: existing.work }, actingSubject: maintainer.actor };
    const concurrentKey = randomUUID();
    const concurrent = await Promise.all([send(maintainer, 'POST', path, existingIntent, concurrentKey),
      send(maintainer, 'POST', path, existingIntent, concurrentKey)]);
    const attached = await json<Identification>(concurrent[0]!);
    expect(await json<Identification>(concurrent[1]!)).toMatchObject({ work: attached.work, relation: attached.relation });
    expect(attached.work).toBe(existing.work);
    const repeatedEvidence = await json<Identification>(await send(maintainer, 'POST', path, existingIntent));
    expect(repeatedEvidence.occurrence).toBe(attached.occurrence);
    const paged = await json<{ items: Identification[]; nextCursor: string | null }>(
      await publicGet(`${path}?limit=1`));
    expect(paged.items).toHaveLength(1); expect(paged.nextCursor).not.toBeNull();
    expect((await json<{ items: Identification[] }>(await publicGet(`${path}?limit=1&cursor=${paged.nextCursor}`)))
      .items).toHaveLength(1);
    const current = await readCurrentOccurrence(stack.env, identified.relation);
    if (!current) throw new Error('Missing relation');
    await json(await send(writer, 'POST', '/v1/relations/changes', { profile: 'relation-change-v1',
      occurrence: identified.relation, expectedHead: current.head, definition: current.state.definition,
      lifecycle: 'retired', evidence: current.state.evidence, participations: [
        { role: 'whole', participant: { kind: 'resource', ref: book.work } },
        { role: 'part', participant: { kind: 'resource', ref: identified.work } }], actingSubject: writer.actor }));
    expect((await json<{ items: Identification[] }>(await publicGet(path))).items.map(item => item.work).sort())
      .toEqual([existing.work, identified.work].sort());
    // Parent membership and realization are independent. Withdrawing only the
    // added occurrence hides its reader link; a retry never reactivates it.
    const ownComposition = await json<{ revision: string }>(await publicGet(`/v1/compositions/${short(identified.structure)}`));
    const remove = { profile: 'book-composition', expectedHead: ownComposition.revision,
      operations: [{ op: 'remove', occurrence: identified.occurrence }], actingSubject: writer.actor };
    await json(await send(writer, 'POST', `/v1/compositions/${short(identified.structure)}/changes`, remove));
    expect((await send(writer, 'POST', `/v1/compositions/${short(identified.structure)}/changes`, remove)).status).toBe(409);
    expect((await json<{ items: Identification[] }>(await publicGet(path))).items.map(item => item.work)).toEqual([existing.work]);
    await json(await send(writer, 'POST', path, intent, key));
    expect((await json<{ items: Identification[] }>(await publicGet(path))).items.map(item => item.work)).toEqual([existing.work]);
    expect(await snapshot()).toEqual(before);
    expect((await send(maintainer, 'POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: post.post,
      variantId: post.variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: draft.revisionId, body: 'Changed by the Book maintainer', actingSubject: maintainer.actor })).status).toBe(403);
  } finally { await stack.stop(); }
}, 180_000);
