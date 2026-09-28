// Seeds one public Work for the Work page e2e into the isolated QA stack the
// e2e harness started: English and Japanese versions, a Realm that adopted it,
// Global and Realm classification with relevance, an original title and
// description, an Open Library and a native Agent credit, Global and Realm
// ratings, a table of contents with published chapters and a reviewed reply,
// an older chapter Work with a public text of its own, and a second Book read
// as one text. It writes through the owner commands and Main routes the Main
// integration tests use (work-read, work-metadata, work-contents,
// work-activity, profiles) and prints the IDs.
import { createHash, randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { activateMetadataWork, GRAPHS, iri, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { authorCreditTriples } from '../../../services/main/src/modules/work/author-credit.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The Work page seed writes only into an isolated QA run');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!objectDirectory) throw new Error('MAIN_OBJECT_DIRECTORY must name the running Main’s object directory');

async function created<T>(response: Response, status = 201): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Seed step failed with ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

const stack = await startMediaStack('work-page-e2e');
// Owner commands keep revision bytes beside the graph and in the object store; point them where the running
// Main reads them, as services/main/src/index.ts configures it.
const workObjects = stack.objects('semantic/work/');
const structureObjects = stack.objects('semantic/structure/');
await Promise.all([workObjects.initialize(), structureObjects.initialize()]);
Object.assign(stack.env, { objectDirectory, workObjects, structureObjects });
try {
  const [a, b, c] = await Promise.all(['reader-a', 'reader-b', 'reader-c'].map(name => stack.member(name)));
  const title = `The Cartographer of Tides ${randomUUID().slice(0, 8)}`;
  // A Book, so its Main Version can own a table of contents; English is its selected text, Japanese a variant.
  const types = ['https://schema.org/Book'];
  const book = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
    a!.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
  if (!book.work || !book.mainVersion) throw new Error('Book was not created');
  const variants = [await stack.contribution(book.work, a!.actor, 'en', `${title} in English`),
    await stack.contribution(book.work, a!.actor, 'ja', `${title} 日本語`)];
  const selection = { context: { kind: 'main-version-default' as const, id: book.mainVersion }, work: book.work,
    contribution: variants[0]!.contribution, publicationDecision: variants[0]!.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: a!.actor };
  const selected = await selectMainDefault(stack.env, stack.admission(a!.actor, `publication:select:${book.mainVersion}`,
    'publication.select', mainSelectionDigest(selection)), selection);
  if (selected.outcome !== 'succeeded') throw new Error('Main selection failed');
  const work = { work: book.work, mainVersion: book.mainVersion, variants };
  const header = await stack.call('GET', `/v1/works/${work.work.slice(-36)}`);
  const { revision } = await header.json() as { revision: string };

  await a!.grant('space:create:root', 'space.create');
  const realm = await created<{ realm: string }>(await a!.send('POST', '/v1/spaces',
    { profile: 'space-realm-v1', name: 'Tidewater Readers', capabilities: ['realm'], actingSubject: a!.actor }));
  await a!.grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
  await created(await a!.send('POST', '/v1/publication-selections', { profile: 'realm-local-selection-v1',
    context: { kind: 'realm-local', id: realm.realm }, work: work.work, mainVersion: work.mainVersion,
    contribution: work.variants[0]!.contribution, publicationDecision: work.variants[0]!.decision,
    expectedSelectionHead: null, selectionBasis: 'realm-manager-review', actingSubject: a!.actor }));

  await a!.grant('classification:define:global', 'classification.proposition.define');
  await a!.grant('classification:decide:global', 'classification.decision.set');
  await a!.grant(`classification:context:${realm.realm}`, 'classification.context.configure');
  await a!.grant(`classification:decide:${realm.realm}`, 'classification.decision.set');
  await created(await a!.send('POST', '/v1/classification-contexts',
    { profile: 'classification-context-v1', realm: realm.realm, actingSubject: a!.actor }));
  const decide = async (label: string, context: { kind: 'global' } | { kind: 'realm-classification'; id: string }) => {
    const proposition = await created<{ sense: string }>(await a!.send('POST', '/v1/classification-propositions',
      { profile: 'classification-proposition-v1', label, actingSubject: a!.actor }));
    const decision = await created<{ decision: string }>(await a!.send('POST', '/v1/classification-decisions', {
      profile: 'classification-direct-decision-v1', work: work.work, mainVersion: work.mainVersion,
      sense: proposition.sense, expectedDecisionHead: null, context, outcome: 'accepted', actingSubject: a!.actor }));
    return { sense: proposition.sense, decision: decision.decision, context };
  };
  const adventure = await decide('Adventure', { kind: 'global' });
  await decide('Estuary cycle', { kind: 'realm-classification', id: realm.realm });

  // Recorded metadata: the original title, localized descriptions and a relevance level.
  await a!.grant(`work:edit:${work.work}`, 'work.edit');
  const metadata = (state: unknown) => a!.send('PUT', `/v1/works/${work.work.slice(-36)}/metadata`,
    { profile: 'work-metadata-details-v1', expectedHead: null, state, actingSubject: a!.actor });
  await created(await metadata({ kind: 'header', originalTitle: { value: 'La Cartographe des marées', language: 'fr' },
    localized: [{ language: 'en', title: null, mainVersionLabel: null,
      description: 'A surveyor maps a delta that redraws itself with every tide.' }] }), 200);
  await created(await metadata({ kind: 'relevance', ...adventure, level: 'central' }), 200);

  // Credits arrive through source adoption, which has no route of its own; write the confirmed triples.
  const credit = authorCreditTriples({ work: work.work, credit: `https://rezics.com/id/${randomUUID()}`,
    revision: `https://rezics.com/id/${randomUUID()}`, expectedHead: revision, sourceKey: '/authors/OL2162284A',
    sourceRoleKey: null, nativeOrdinal: 0, actingSubject: a!.actor }, stack.env.lineage.dataEpoch, '0');
  await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
    GRAPH ${iri(GRAPHS.current)} { ${credit.current} }
    GRAPH ${iri(GRAPHS.revisions)} { ${credit.revision} } }`);

  await a!.grant(`rating:context:${realm.realm}`, 'rating.context.create');
  await a!.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
  const global = await created<{ context: string }>(await a!.send('POST', '/v1/global-rating-contexts',
    { profile: 'global-rating-standing-context-v1', question: 'How good is this Work overall?', actingSubject: a!.actor }));
  const local = await created<{ context: string }>(await a!.send('POST', '/v1/rating-contexts',
    { profile: 'realm-standing-rating-context-v1', realm: realm.realm, question: 'How well does it fit Tidewater Readers?',
      actingSubject: a!.actor }));
  for (const [member, globalValue, realmValue] of [[a!, 5, 8], [b!, 4, 6], [c!, 5, null]] as const) {
    await member.grant(`rating:observe:${global.context}`, 'rating.observation.set');
    await created(await member.send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context: global.context, work: work.work,
      mainVersion: work.mainVersion, expectedRevisionHead: null, value: globalValue, actingSubject: member.actor }));
    if (realmValue === null) continue;
    await member.grant(`rating:observe:${local.context}`, 'rating.observation.set');
    await created(await member.send('POST', '/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1', context: local.context, work: work.work,
      mainVersion: work.mainVersion, expectedRevisionHead: null, value: realmValue, actingSubject: member.actor }));
  }

  // One app with the owners the default QA app leaves out: Agent profiles and Realm replies.
  const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, content: stack.content,
    contentAuthoring: stack.content,
    media: stack.media, structureObjects, profiles: new ProfilesAccess(stack.accessPool),
    agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
    realmReplies: new RealmReplyStore(new RealmReplyContentStore(stack.contentPool), stack.content, stack.access,
      stack.env), account: { verify: async () => a!.principal } });
  const send = (method: string, path: string, body: unknown) => app.handle(new Request(`http://main.local${path}`, {
    method, headers: { authorization: `Bearer ${a!.token}`, 'content-type': 'application/json',
      'idempotency-key': randomUUID() }, body: JSON.stringify(body) }));
  const grantAs = async (actor: string, scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation(id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), a!.principalId, actor, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,
      action,valid_until) VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
  };
  const head = async () => (await (await stack.call('GET', `/v1/works/${work.work.slice(-36)}`)).json() as
    { revision: string }).revision;

  // A native credit: a public pen-name Agent credited as author.
  const author = await created<{ agent: string }>(await send('POST', '/v1/agents',
    { profile: 'agent-provision-v1', displayName: 'Maren Osei', kind: 'person' }));
  await grantAs(author.agent, `work:edit:${work.work}`, 'work.edit');
  await created(await send('POST', `/v1/works/${work.work.slice(-36)}/agent-credits`, {
    profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`, agent: author.agent,
    role: 'author', expectedWorkHead: await head(), actingSubject: author.agent }));

  // A table of contents for the Main Version: two published chapters and one with no publication.
  const chapterWork = async (label: string, body: string | null) => {
    const target = await stack.privateWork(a!.actor, label);
    // The composition editor must be able to read every chapter target, published or not.
    await a!.grant(`work:read:${target.work}`, 'work.read');
    if (body === null) return target.work;
    await a!.grant(`content:draft:${target.work}`, 'content.draft');
    const variant = `urn:rezics:variant:${randomUUID()}`;
    // The admitted publication and eligibility routes ask for authority on the Work, not the variant.
    await a!.grant(`content:publish:${target.work}`, 'content.publish');
    await a!.grant(`content:search-eligibility:${target.work}`, 'content.search-eligibility');
    const saved = await created<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(await a!.send('POST',
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: target.work, variantId: variant,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null, body,
        actingSubject: a!.actor }));
    const exact = (await stack.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Chapter draft was not saved');
    const published = await created<{ decision: string }>(await a!.send('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `work-page-${randomUUID()}`, revisionId: saved.revisionId,
      expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
      resourceId: target.work, variantId: variant, expectedPublicationHead: null, actingSubject: a!.actor }));
    await created(await a!.send('POST', '/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
      resourceId: target.work, variantId: variant, publicationDecision: published.decision,
      expectedEligibilityHead: null, actingSubject: a!.actor, rightsBasis: 'original-contribution',
      disclosure: 'public' }));
    return target.work;
  };
  const low = await chapterWork('Low Water', ['The tide went out at four and took the eastern bank with it.',
    'Maren had learned not to trust anything the river left behind.'].join('\n'));
  const chain = await chapterWork('The Surveyor’s Chain', ['She set the chain across the mud and counted the links aloud.',
    'By evening the ledger disagreed with the city again.'].join('\n'));
  const neap = await chapterWork('Neap Tide', null);
  const composition = await created<{ structure: string; revision: string }>(await a!.send('POST', '/v1/compositions',
    { profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: a!.actor }));
  const arranged = await created<{ occurrences: string[] }>(await a!.send('POST',
    `/v1/compositions/${composition.structure.slice(-36)}/changes`, { profile: 'book-composition',
      expectedHead: composition.revision, actingSubject: a!.actor, operations: [
        { op: 'insert', parent: composition.structure, position: 'last', role: 'chapter', target: low,
          label: { value: 'Low Water', language: 'en' } },
        { op: 'insert', parent: composition.structure, position: 'last', role: 'chapter', target: chain,
          label: { value: 'The Surveyor’s Chain', language: 'en' } },
        { op: 'insert', parent: composition.structure, position: 'last', role: 'chapter', target: neap,
          label: { value: 'Neap Tide', language: 'en' } },
      ] }), 200);

  // An older chapter Work with a public text of its own, as early serial seeds made them: its address is the
  // chapter's place in the Book's reader, not a Work page.
  const chainText = await stack.contribution(chain, a!.actor, 'en', 'She set the chain across the mud.');
  const chainMain = (await stack.fuseki.query(`SELECT ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(chain)} <${RV}mainVersion> ?main } }`)).results?.bindings[0]?.main?.value;
  if (!chainMain) throw new Error('Chapter Work has no Main Version');
  const chainSelection = { context: { kind: 'main-version-default' as const, id: chainMain }, work: chain,
    contribution: chainText.contribution, publicationDecision: chainText.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: a!.actor };
  if ((await selectMainDefault(stack.env, stack.admission(a!.actor, `publication:select:${chainMain}`,
    'publication.select', mainSelectionDigest(chainSelection)), chainSelection)).outcome !== 'succeeded') {
    throw new Error('Chapter Work text was not selected');
  }

  // A Book with no chapters: its Main Version is one selected text, read as a whole.
  const singleTitle = `Tide Tables ${randomUUID().slice(0, 8)}`;
  const single = await activateMetadataWork(stack.env, { title: singleTitle, semanticTypes: types,
    admission: stack.admission(a!.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(singleTitle, types)) });
  if (!single.work || !single.mainVersion) throw new Error('Single-text Book was not created');
  const singleText = await stack.contribution(single.work, a!.actor, 'en',
    ['High water at dawn, low water by noon.', 'The tables were right for a hundred years, then the river moved.'].join('\n'));
  const singleSelection = { context: { kind: 'main-version-default' as const, id: single.mainVersion },
    work: single.work, contribution: singleText.contribution, publicationDecision: singleText.decision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: a!.actor };
  if ((await selectMainDefault(stack.env, stack.admission(a!.actor, `publication:select:${single.mainVersion}`,
    'publication.select', mainSelectionDigest(singleSelection)), singleSelection)).outcome !== 'succeeded') {
    throw new Error('Single-text Book text was not selected');
  }

  // A reply reviewed and placed in the Realm, so Discussion and History have one.
  const reply = `https://rezics.com/id/${randomUUID()}`;
  const replyVariant = `urn:rezics:variant:${randomUUID()}`;
  const replyText = 'The chapter where the map floods is the best thing I have read this year.';
  const rootRevision = (await stack.fuseki.query(`SELECT ?draft WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(work.variants[0]!.decision)} <${RV}selectedDraft> ?draft }
  }`)).results?.bindings[0]?.draft?.value;
  if (!rootRevision) throw new Error('Published contribution has no selected draft');
  stack.access.configureBaseline(stack.fuseki);
  await a!.grant(`content:draft:${reply}`, 'content.draft');
  const saved = await created<{ revisionId: string }>(await send('POST', '/v1/member-reply-drafts', {
    profile: 'member-reply-draft-v1', reply, variantId: replyVariant, rootTarget: work.work, rootRevision,
    language: 'en', direction: 'ltr', expectedHead: null, body: replyText, actingSubject: a!.actor }));
  const digest = (await stack.contentPool.query<{ byte_digest: string }>(
    'SELECT byte_digest FROM content.revision WHERE id = $1', [saved.revisionId])).rows[0]!.byte_digest;
  await a!.grant(`reply:create:${work.work}`, 'reply.create');
  await a!.grant(`review:decide:${realm.realm}`, 'review.decide');
  await a!.grant(`reply:place:${realm.realm}`, 'reply.place');
  await created(await send('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply,
    variantId: replyVariant, revisionId: saved.revisionId, author: a!.actor, rootTarget: work.work,
    rootRevision, parentReply: null, parentRevision: null, contextRevision: null }));
  const review = await created<{ decisionId: string }>(await send('POST', '/v1/realm-reply-reviews', {
    profile: 'realm-reply-review-v1', realm: realm.realm, reply, revisionId: saved.revisionId, revisionDigest: digest,
    expectedGeneration: '0', supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
    dependencyDigest: createHash('sha256').update(rootRevision).digest('hex'), reasonReference: null,
    actingSubject: a!.actor }));
  await created(await send('POST', '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1',
    realm: realm.realm, reply, revisionId: saved.revisionId, revisionDigest: digest,
    reviewDecisionId: review.decisionId, expectedHead: null, actingSubject: a!.actor }));

  console.log(JSON.stringify({ work: work.work, realm: realm.realm, title, reply: replyText,
    chapters: arranged.occurrences, targets: [low, chain], single: { work: single.work, title: singleTitle } }));
} finally {
  await stack.stop();
}
