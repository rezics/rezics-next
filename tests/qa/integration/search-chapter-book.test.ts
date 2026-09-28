import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { startMediaStack } from './media-support.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { activateMetadataWork, GRAPHS, iri, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, PUBLIC_SEARCH_GRAPH, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
import { backfillChapterSearchIndex }
  from '../../../services/main/src/modules/work/search-index-backfill.ts';
import { clearQuarantinedContentUnits, quarantinePublicContentSearch,
  replayQuarantinedContentCut, verifyQuarantinedContentIndex }
  from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { seedContent } from '../load/corpus.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('chapter Book and single-text Work survive Content rebuild verification alongside search and lists', async () => {
  const stack = await startMediaStack('search-chapter-book');
  try {
    const actor = await stack.member('chapter-owner');
    const bookTitle = `雨夜书店 ${randomUUID().slice(0, 8)}`;
    const created = await activateMetadataWork(stack.env, { title: bookTitle,
      semanticTypes: ['https://schema.org/Book'],
      admission: stack.admission(actor.actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(bookTitle, ['https://schema.org/Book'])) });
    if (!created.work || !created.mainVersion) throw new Error('Book was not created');
    const book = { work: created.work, mainVersion: created.mainVersion };
    const publish = async (work: string, mainVersion: string, body: string) => {
      const source = await stack.contribution(work, actor.actor, 'zh', body);
      const input = { context: { kind: 'main-version-default' as const, id: mainVersion },
        work, contribution: source.contribution, publicationDecision: source.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const,
        actingSubject: actor.actor };
      await selectMainDefault(stack.env,
        stack.admission(actor.actor, `publication:select:${mainVersion}`, 'publication.select',
          mainSelectionDigest(input)), input);
      return source;
    };
    const bookSource = await publish(book.work, book.mainVersion, '雨夜书店的故事');
    await actor.grant(`work:edit:${book.work}`, 'work.edit');
    await actor.grant(`work:read:${book.work}`, 'work.read');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof objects }).structureObjects = objects;
    const structure = await json<{ structure: string; revision: string }>(await actor.send('POST',
      '/v1/compositions', { profile: 'book-composition', work: book.work,
        mainVersion: book.mainVersion, actingSubject: actor.actor }), 201);
    const first = await json<{ work: string; mainVersion: string; compositionRevision: string }>(await actor.send('POST',
      `/v1/works/${short(book.work)}/chapters`, { profile: 'book-chapter-create-v1',
        title: '第一章 雨夜', language: 'zh', direction: 'ltr', parent: structure.structure,
        position: 'last', expectedCompositionHead: structure.revision,
        actingSubject: actor.actor }));
    const firstSource = await publish(first.work, first.mainVersion, '雨夜 第一章的故事');
    const chapterTitle = '第二章 旧信';
    const chapter = await json<{ work: string; mainVersion: string }>(await actor.send('POST',
      `/v1/works/${short(book.work)}/chapters`, { profile: 'book-chapter-create-v1',
        title: chapterTitle, language: 'zh', direction: 'ltr', parent: structure.structure,
        position: 'last', expectedCompositionHead: first.compositionRevision,
        actingSubject: actor.actor }));
    const chapterSource = await publish(chapter.work, chapter.mainVersion, '独有线索藏在第二页');
    const indexed = await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?unit ?book WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:work ${iri(chapter.work)} ;
        rv:searchResultWork ?book . } }`);
    expect(indexed.results?.bindings.map(row => row.book?.value)).toEqual([book.work]);
    // Simulate a chapter MatchUnit written before Book identities were stamped.
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:searchResultWork ?book ;
        rv:searchResultMain ?main ; rv:searchChapterTitle ?title . }
    } WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:work ${iri(chapter.work)} ;
      rv:searchResultWork ?book ; rv:searchResultMain ?main ; rv:searchChapterTitle ?title . } }`);
    const maintenance = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!,
      Bun.env.FUSEKI_COMMAND_TOKEN!);
    expect(await backfillChapterSearchIndex({ ...stack.env, fuseki: maintenance })).toBe(1);
    const batches = await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?batch WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ?batch a rv:OutboxBatch ; rv:eventCount 0 . } }`);
    expect(batches.results?.bindings).toHaveLength(1);
    const query = (phrase: string) => stack.call('POST', '/v1/queries', { body: {
      profile: 'public-main-phrase-v1', phrase, language: null } });
    const title = await json<{ results: Array<{ work: string }> }>(await query('雨夜书店'));
    expect(title.results.map(row => row.work)).toEqual([book.work]);
    const before = stack.fuseki.queries;
    const body = await json<{ total: number; results: Array<{ work: string;
      mainVersion: string; matchedChapter?: { work: string; title: string } }> }>(await query('独有线索'));
    expect(stack.fuseki.queries - before).toBeLessThanOrEqual(36);
    expect(body).toMatchObject({ total: 1, results: [{ work: book.work,
      mainVersion: book.mainVersion,
      matchedChapter: { work: chapter.work, title: chapterTitle } }] });
    const suggest = await json<{ items: Array<{ work: string; matchedText: string }> }>(
      await stack.call('GET', `/v1/search/typeahead?prefix=${encodeURIComponent('第二章')}`));
    expect(suggest.items).toMatchObject([{ work: book.work, matchedText: chapterTitle }]);

    await actor.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string }>(await actor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Chapter reading Realm', capabilities: ['realm'],
      actingSubject: actor.actor }), 201);
    await actor.grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
    const adopt = (target: typeof book, source: typeof bookSource) => actor.send('POST',
      '/v1/publication-selections', { profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: realm.realm }, work: target.work,
        mainVersion: target.mainVersion, contribution: source.contribution,
        publicationDecision: source.decision, expectedSelectionHead: null,
        selectionBasis: 'realm-manager-review', actingSubject: actor.actor });
    await json(await adopt(book, bookSource), 201);
    await json(await adopt(first, firstSource), 201);
    await json(await adopt(chapter, chapterSource), 201);
    const works = await json<{ items: Array<{ id: string }> }>(await stack.call('GET',
      `/v1/realms/${short(realm.realm)}/works`));
    expect(works.items.map(item => item.id)).toEqual([book.work]);
    const zone = await json<{ items: Array<{ id: string }> }>(await stack.call('GET',
      `/v1/realms/${short(realm.realm)}/modules/new-adoptions`));
    expect(zone.items.map(item => item.id)).toEqual([book.work]);

    // Rebuild with both the chaptered Book and a separate one-text Work in the
    // same graph. The Book's Content source exercises exact replay checks.
    const single = await stack.publicWork(actor.actor, ['en'], `Single text ${randomUUID()}`);
    const source = await seedContent(stack.env, stack.contentPool, stack.accessPool,
      book.work, 'Book exact rebuild text');
    const cursor = new ContentProjectionCursor(stack.contentPool);
    const maintenanceEnv = { ...stack.env, fuseki: maintenance };
    const job = await quarantinePublicContentSearch(maintenanceEnv, stack.content, randomUUID());
    expect(await clearQuarantinedContentUnits(maintenanceEnv, job)).toBe(0);
    expect(await replayQuarantinedContentCut(maintenanceEnv, stack.content, cursor, job)).toBeGreaterThan(0);
    const snapshot = await verifyQuarantinedContentIndex(maintenanceEnv, stack.content, cursor, job);
    expect(snapshot.contentUnitCount).toBe(1);
    const preserved = await maintenance.query(`PREFIX rv: <${RV}> SELECT ?book ?chapter WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:work ${iri(chapter.work)} ;
        rv:searchResultWork ?book ; rv:searchChapterTitle ?chapter . } }`);
    expect(preserved.results?.bindings.length).toBeGreaterThan(0);
    expect(preserved.results?.bindings.every(row => row.book?.value === book.work
      && row.chapter?.value === chapterTitle)).toBe(true);
    const singleBody = await maintenance.query(`PREFIX rv: <${RV}> SELECT ?unit WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:work ${iri(single.work)} ; rv:field rv:Body . } }`);
    expect(singleBody.results?.bindings).toHaveLength(1);
    const exact = (await stack.content.readExactBatch([source.revisionId],
      async ids => new Set(ids)))[0];
    expect(exact?.status).toBe('available');
  } finally { await stack.stop(); }
}, 240_000);
