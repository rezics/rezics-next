import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { RightsStore, PUBLIC_DOMAIN_TEXT_USE, publicDomainWorkMaterial } from '../../../services/main/src/modules/rights/store.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { clearQuarantinedContentUnits, quarantinePublicContentSearch,
  replayQuarantinedContentCut, verifyQuarantinedContentIndex }
  from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { activateMetadataWork, metadataWorkRequestDigest, PUBLIC_SEARCH_ANCHOR, RV, iri }
  from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, PUBLIC_SEARCH_GRAPH, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

for (const basis of ['original-contribution', 'public-domain'] as const) {
test(`Studio ${basis} chapter Content resolves to its public Book on the Main phrase page`, async () => {
  const stack = await startMediaStack('search-studio-content', { contentProjection: true });
  try {
    const actor = await stack.member('chapter-author');
    const rights = new RightsStore(stack.contentPool, stack.accessPool);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      account: { verify: async () => actor.principal }, content: stack.content, contentAuthoring: stack.content,
      contentProjection: { content: stack.content, cursor: stack.contentCursor, consumer: stack.contentConsumer },
      rights: { store: rights } });
    const call = (path: string, body: unknown) => app.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(path.startsWith('/v1/queries') ? {} : { authorization: 'Bearer qa' }),
        'idempotency-key': randomUUID() }, body: JSON.stringify(body) }));
    if (basis === 'public-domain') await actor.grant('rights:assess', 'rights.assess');
    const assess = (work: string, expectedAssessment: string | null = null) => rights.assess(actor.principal, {
      actingSubject: actor.actor, material: publicDomainWorkMaterial(work), expressionKind: 'expression',
      ...PUBLIC_DOMAIN_TEXT_USE, basis: 'public_domain', outcome: expectedAssessment ? 'not_supported' : 'supported',
      licenseInstrument: null, exceptionKind: null, rationale: null, extent: {}, evidence: { fixture: true },
      obligations: [], expectedAssessment, idempotencyKey: randomUUID() });
    await stack.contentCursor.initialize(stack.contentConsumer);
    const title = `雨夜书店 ${randomUUID().slice(0, 8)}`;
    const created = await activateMetadataWork(stack.env, { title,
      semanticTypes: ['https://schema.org/Book'],
      admission: stack.admission(actor.actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(title, ['https://schema.org/Book'])) });
    const opening = await stack.contribution(created.work, actor.actor, 'zh-Hans', '书店开门了');
    const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: opening.contribution, publicationDecision: opening.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const,
      actingSubject: actor.actor };
    await selectMainDefault(stack.env, stack.admission(actor.actor,
      `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
    await actor.grant(`work:edit:${created.work}`, 'work.edit');
    await actor.grant(`work:read:${created.work}`, 'work.read');
    const structureObjects = stack.objects('semantic/structure/');
    await structureObjects.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof structureObjects }).structureObjects = structureObjects;
    const composition = await json<{ structure: string; revision: string }>(await actor.send('POST',
      '/v1/compositions', { profile: 'book-composition', work: created.work,
        mainVersion: created.mainVersion, actingSubject: actor.actor }), 201);
    const makeChapter = async (chapterTitle: string, expectedCompositionHead: string) =>
      json<{ work: string; compositionRevision: string }>(await actor.send('POST',
        `/v1/works/${short(created.work)}/chapters`, { profile: 'book-chapter-create-v1',
          title: chapterTitle, language: 'zh-Hans', direction: 'ltr', parent: composition.structure,
          position: 'last', expectedCompositionHead, actingSubject: actor.actor }));
    const first = await makeChapter('第一章 雨夜', composition.revision);
    const second = await makeChapter('第二章 未寄出的信', first.compositionRevision);
    const publishChapter = async (chapter: typeof first, chapterTitle: string, text: string) => {
      await actor.grant(`work:read:${chapter.work}`, 'work.read');
      await actor.grant(`content:draft:${chapter.work}`, 'content.draft');
      await actor.grant(`content:publish:${chapter.work}`, 'content.publish');
      await actor.grant(`content:search-eligibility:${chapter.work}`, 'content.search-eligibility');
      const assessment = basis === 'public-domain' ? await assess(chapter.work) : null;
      const sourced = assessment ? { assessmentId: assessment.assessmentId, source: {
        provider: 'project-gutenberg', identifier: 'ebook/1342', url: 'https://www.gutenberg.org/ebooks/1342',
        byteDigest: 'a'.repeat(64), retrievedAt: '2026-09-28T00:00:00.000Z' } } : {};
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      const draft = await json<{ revisionId: string; byteDigest: string;
        sourcePosition: { dataEpoch: string } }>(await call('/v1/content-drafts', {
        profile: assessment ? 'content-public-domain-text-v1' : 'content-text-v1', ...sourced, resourceId: chapter.work, variantId,
        language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-Hans' }, direction: 'ltr',
        expectedHead: null, body: `${chapterTitle}\n${text}`, actingSubject: actor.actor }), 201);
      const published = await json<{ status: string; decision: string }>(await actor.send('POST',
        '/v1/content-publications', { profile: 'content-publication-v1',
          preparationId: `chapter-${randomUUID()}`, revisionId: draft.revisionId,
          expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
          resourceId: chapter.work, variantId, expectedPublicationHead: null,
          actingSubject: actor.actor }), 201);
      expect(published.status).toBe('active');
      await json(await call('/v1/content-search-eligibility', {
        profile: assessment ? 'content-search-eligibility-v2' : 'content-search-eligibility-v1',
        ...(assessment ? { assessmentId: assessment.assessmentId } : {}), resourceId: chapter.work, variantId,
        publicationDecision: published.decision, expectedEligibilityHead: null,
        actingSubject: actor.actor, rightsBasis: basis, disclosure: 'public' }), 201);
      return assessment;
    };
    await publishChapter(first, '第一章 雨夜', '雨夜里有人推开书店的门。');
    const phrase = basis === 'public-domain' ? '公共领域章节里的那张旧车票' : '信封里只有一张旧车票';
    const secondAssessment = await publishChapter(second, '第二章 未寄出的信', `${phrase}，日期是二十年前。`);
    const pageInput = { profile: 'public-main-phrase-page-v1', phrase, language: null, pageSize: 10 };
    expect((await call('/v1/queries/page', pageInput)).status).toBe(503);
    const command = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!,
      Bun.env.FUSEKI_COMMAND_TOKEN!);
    const relayEnv = { ...stack.env, fuseki: command };
    const cut = await stack.content.ownerPosition();
    for (let i = 0; i < 12 && (await stack.contentCursor.read(stack.contentConsumer)).sequence !== cut.sequence; i++) {
      if (!await relayContentProjectionOnce(relayEnv, stack.content,
        stack.contentCursor, stack.contentConsumer)) throw new Error('Content relay stopped before its source cut');
    }
    expect((await stack.contentCursor.read(stack.contentConsumer)).sequence).toBe(cut.sequence);
    const unit = await command.query(`PREFIX rv: <${RV}> SELECT ?book ?title WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:resource ${iri(second.work)} ;
        rv:searchResultWork ?book ; rv:searchChapterTitle ?title . } }`);
    expect(unit.results?.bindings).toMatchObject([{ book: { value: created.work },
      title: { value: '第二章 未寄出的信' } }]);
    const queryStart = stack.fuseki.queries;
    const page = await json<{ total: number; results: Array<{ work: string;
      matchedChapter?: { work: string; title: string } }> }>(
      await call('/v1/queries/page', pageInput));
    expect(stack.fuseki.queries - queryStart).toBeLessThanOrEqual(36);
    expect(page).toMatchObject({ total: 1, results: [{ work: created.work,
      matchedChapter: { work: second.work, title: '第二章 未寄出的信' } }] });
    expect((await stack.call('GET', `/v1/works/${short(second.work)}`)).status).toBe(404);
    if (secondAssessment) {
      await assess(second.work, secondAssessment.assessmentId);
      expect(await json(await call('/v1/queries/page', pageInput))).toMatchObject({ total: 0, results: [] });
    }
    const job = await quarantinePublicContentSearch(relayEnv, stack.content, randomUUID());
    expect(await clearQuarantinedContentUnits(relayEnv, job)).toBeGreaterThanOrEqual(2);
    expect(await replayQuarantinedContentCut(relayEnv, stack.content,
      stack.contentCursor, job)).toBeGreaterThan(0);
    expect((await verifyQuarantinedContentIndex(relayEnv, stack.content,
      stack.contentCursor, job)).contentUnitCount).toBeGreaterThanOrEqual(2);
  } finally {
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`);
    await stack.stop();
  }
}, 240_000);
}
