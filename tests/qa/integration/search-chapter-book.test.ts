import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { startMediaStack } from './media-support.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { activateMetadataWork, GRAPHS, iri, metadataWorkRequestDigest, PUBLIC_SEARCH_ANCHOR, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, PUBLIC_SEARCH_GRAPH, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
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

test('Anthology entry Works remain visible in search and Realm/Zone lists through Content rebuild', async () => {
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
    // Independently maintained anthology entries retain their Work identity.
    const first = await stack.privateWork(actor.actor, 'First anthology entry');
    const firstSource = await publish(first.work, first.mainVersion, '雨夜 第一章的故事');
    const chapterTitle = '第二章 旧信';
    const chapter = await stack.privateWork(actor.actor, chapterTitle);
    const chapterSource = await publish(chapter.work, chapter.mainVersion, '独有线索藏在第二页');
    for (const target of [first.work, chapter.work]) await actor.grant(`work:read:${target}`, 'work.read');
    await json(await actor.send('POST', `/v1/compositions/${short(structure.structure)}/changes`, {
      profile: 'book-composition', expectedHead: structure.revision, actingSubject: actor.actor,
      operations: [first, chapter].map(entry => ({ op: 'insert', role: 'chapter',
        parent: structure.structure, position: 'last', target: entry.work })),
    }));
    const maintenance = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!,
      Bun.env.FUSEKI_COMMAND_TOKEN!);
    const query = (phrase: string) => stack.call('POST', '/v1/queries', { body: {
      profile: 'public-main-phrase-v1', phrase, language: null } });
    const title = await json<{ results: Array<{ work: string }> }>(await query('雨夜书店'));
    expect(title.results.map(row => row.work)).toEqual([book.work]);
    const before = stack.fuseki.queries;
    const body = await json<{ total: number; results: Array<{ work: string;
      mainVersion: string; matchedChapter?: { work: string; title: string } }> }>(await query('独有线索'));
    expect(stack.fuseki.queries - before).toBeLessThanOrEqual(36);
    expect(body).toMatchObject({ total: 1, results: [{ work: chapter.work,
      mainVersion: chapter.mainVersion }] });
    const suggest = await json<{ items: Array<{ work: string; matchedText: string }> }>(
      await stack.call('GET', `/v1/search/typeahead?prefix=${encodeURIComponent('第二章')}`));
    expect(suggest.items).toMatchObject([{ work: chapter.work, matchedText: chapterTitle }]);

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
    expect(works.items.map(item => item.id).sort()).toEqual([book.work, first.work, chapter.work].sort());
    const zone = await json<{ items: Array<{ id: string }> }>(await stack.call('GET',
      `/v1/realms/${short(realm.realm)}/modules/new-adoptions`));
    expect(zone.items.map(item => item.id).sort()).toEqual([book.work, first.work, chapter.work].sort());

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
    const preserved = await maintenance.query(`PREFIX rv: <${RV}> SELECT ?unit WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:work ${iri(chapter.work)} ; rv:field rv:Body . } }`);
    expect(preserved.results?.bindings).toHaveLength(2);
    const singleBody = await maintenance.query(`PREFIX rv: <${RV}> SELECT ?unit WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:work ${iri(single.work)} ; rv:field rv:Body . } }`);
    expect(singleBody.results?.bindings).toHaveLength(1);
    const exact = (await stack.content.readExactBatch([source.revisionId],
      async ids => new Set(ids)))[0];
    expect(exact?.status).toBe('available');
  } finally {
    // This integration tier shares one QA graph across files. Restore its live
    // anchor after verifying the quarantined state, using the raw fault alias.
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`);
    await stack.stop();
  }
}, 240_000);
