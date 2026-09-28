import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HOME_READ_BUDGET, meterStatements, seedHome, startHomeStack } from './feed-read-support.ts';
import { startMediaStack } from './media-support.ts';
import { GRAPHS, RV, activateMetadataWork, iri, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { nextChapter } from '../../../services/main/src/modules/structure/reading-order.ts';
import { readCompositionPage } from '../../../services/main/src/modules/structure/read.ts';
import { WORK_CONTENTS_COST } from '../../../services/main/src/modules/work-contents/read-contract.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
type Item = { occurrence: string; role: string; division: string | null; number: number | null;
  childCount: number | null; label: { value: string } | null };
type Chapter = { previous: string | null; next: string | null; number: number | null; ordinal: number;
  parentPath: Array<{ occurrence: string; division: string | null; number: number | null;
    label: { value: string } | null }> };
/** Graph queries one read may spend on a multi-volume Book, with the Contents numbering pass. */
const READ_QUERIES = 64;

test('BOOK02/COMP06: volumes, parts and extras are revisioned groups that Contents, the reader and Continue follow', async () => {
  const stack = await startMediaStack('book-volumes');
  try {
    const a = await stack.member('volumes-author');
    const title = `Volumes Book ${randomUUID()}`;
    const created = await activateMetadataWork(stack.env, { title, semanticTypes: ['https://schema.org/Book'],
      admission: stack.admission(a.actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(title, ['https://schema.org/Book'])) });
    if (!created.work || !created.mainVersion) throw new Error('Book was not created');
    const book = { work: created.work, mainVersion: created.mainVersion };
    const selectedText = await stack.contribution(book.work, a.actor, 'en', 'A book in volumes');
    const selected = { context: { kind: 'main-version-default' as const, id: book.mainVersion },
      work: book.work, contribution: selectedText.contribution, publicationDecision: selectedText.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: a.actor };
    await selectMainDefault(stack.env, stack.admission(a.actor, `publication:select:${book.mainVersion}`,
      'publication.select', mainSelectionDigest(selected)), selected);
    // One public chapter text; every chapter below is a use of it, as a target may repeat.
    const text = await stack.privateWork(a.actor, 'Volumes chapter text');
    for (const [scope, action] of [[`work:edit:${book.work}`, 'work.edit'], [`work:read:${book.work}`, 'work.read'],
      [`work:read:${text.work}`, 'work.read'], [`content:draft:${text.work}`, 'content.draft'],
      [`content:publish:${text.work}`, 'content.publish'],
      [`content:search-eligibility:${text.work}`, 'content.search-eligibility']] as const) await a.grant(scope, action);
    const store = stack.objects('semantic/structure/');
    await store.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof store }).structureObjects = store;
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const saved = await json<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(await a.send('POST',
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: text.work, variantId: variant,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
        body: 'It rained until the shop closed.', actingSubject: a.actor }), 201);
    const exact = (await stack.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Content draft was not saved');
    const published = await json<{ decision: string }>(await a.send('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `volumes-${randomUUID()}`, revisionId: saved.revisionId,
      expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
      resourceId: text.work, variantId: variant, expectedPublicationHead: null, actingSubject: a.actor }), 201);
    await json(await a.send('POST', '/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
      resourceId: text.work, variantId: variant, publicationDecision: published.decision,
      expectedEligibilityHead: null, actingSubject: a.actor, rightsBasis: 'original-contribution',
      disclosure: 'public' }), 201);

    const made = await json<{ structure: string; revision: string }>(await a.send('POST', '/v1/compositions',
      { profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: a.actor }), 201);
    const changes = `/v1/compositions/${short(made.structure)}/changes`;
    const change = (expectedHead: string, operations: object[], key?: string) => a.send('POST', changes,
      { profile: 'book-composition', expectedHead, actingSubject: a.actor, operations }, key);
    const label = (value: string) => ({ value, language: 'en' });
    const chapter = (parent: string, value: string) => ({ op: 'insert', parent, position: 'last',
      role: 'chapter', target: text.work, label: label(value) });

    // A prologue, two volumes and extras at the top level.
    const top = await json<{ revision: string; occurrences: string[] }>(await change(made.revision, [
      chapter(made.structure, 'Prologue'),
      { op: 'insert', parent: made.structure, position: 'last', role: 'group', label: label('The Rain'),
        division: 'volume' },
      { op: 'insert', parent: made.structure, position: 'last', role: 'group', label: label('After the Rain'),
        division: 'volume' },
      { op: 'insert', parent: made.structure, position: 'last', role: 'group', label: label('Extras'),
        division: 'extras' },
    ]));
    const [prologue, one, two, extras] = top.occurrences as [string, string, string, string];
    const filled = await json<{ revision: string; occurrences: string[] }>(await change(top.revision, [
      chapter(one, 'The Letter'), chapter(one, 'The Ticket'), chapter(two, 'The Last Train'),
      chapter(two, 'The Station'), chapter(extras, 'The Cat'),
    ]));
    const [letter, ticket, train, station, cat] = filled.occurrences as [string, string, string, string, string];

    // A group nests only directly under the Book; a chapter only one group deep.
    const nested = await change(filled.revision, [{ op: 'insert', parent: one, position: 'last', role: 'group',
      label: label('Too deep') }]);
    expect(nested.status).toBe(409);
    expect(await nested.json()).toMatchObject({ code: 'composition_conflict' });
    expect((await change(filled.revision, [{ op: 'insert', parent: made.structure, position: 'last',
      role: 'chapter', target: text.work, division: 'volume' }])).status).toBe(400);
    // A group with chapters stays until it is empty.
    expect((await change(filled.revision, [{ op: 'remove', occurrence: one }])).status).toBe(409);

    // Rename a volume: one revisioned update with its own history kind, replayable by key.
    const renameKey = `rename-${randomUUID()}`;
    const rename = [{ op: 'update', occurrence: two, label: label('Book Two: After the Rain') }];
    const renamed = await json<{ revision: string; replayed: boolean; expectedHead: string }>(
      await change(filled.revision, rename, renameKey));
    expect(renamed).toMatchObject({ replayed: false, expectedHead: filled.revision });
    expect(await json<{ revision: string; replayed: boolean }>(await change(filled.revision, rename, renameKey)))
      .toMatchObject({ revision: renamed.revision, replayed: true });
    expect((await change(filled.revision, rename)).status).toBe(409);
    const history = await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?kind ?predecessor WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(renamed.revision)} rv:structureOperation ?kind ;
        rv:predecessor ?predecessor . } }`);
    expect(history.results?.bindings.map(row => [row.kind?.value, row.predecessor?.value]))
      .toEqual([[`${RV}OccurrenceUpdate`, filled.revision]]);
    const divided = await json<{ revision: string }>(await change(renamed.revision,
      [{ op: 'update', occurrence: extras, division: 'extras', label: label('Side Stories') }]));
    const qualifier = await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?division WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?placement rv:occurrence ${iri(extras)} ; rv:qualifier ?q .
        ?q a rv:BookGroup ; rv:bookDivision ?division . } }`);
    expect(qualifier.results?.bindings.map(row => row.division?.value)).toEqual([`${RV}ExtrasDivision`]);
    let head = divided.revision;

    // Contents: the top level lists volumes numbered, extras unnumbered, and each group's chapter count.
    const contents = `/v1/works/${short(book.work)}/contents`;
    let queries = stack.fuseki.queries;
    const root = await json<{ items: Item[] }>(await stack.call('GET', contents));
    expect(stack.fuseki.queries - queries).toBeLessThanOrEqual(READ_QUERIES);
    expect(root.items.map(item => [item.label?.value, item.role, item.division, item.number, item.childCount]))
      .toEqual([['Prologue', 'chapter', null, 1, null], ['The Rain', 'group', 'volume', 1, 2],
        ['Book Two: After the Rain', 'group', 'volume', 2, 2], ['Side Stories', 'group', 'extras', null, 1]]);
    // Story chapters are numbered through the Book; extras stay unnumbered.
    queries = stack.fuseki.queries;
    const volumeTwo = await json<{ items: Item[] }>(await stack.call('GET', `${contents}?parent=${encodeURIComponent(two)}`));
    expect(stack.fuseki.queries - queries).toBeLessThanOrEqual(READ_QUERIES);
    expect(volumeTwo.items.map(item => [item.label?.value, item.number])).toEqual([['The Last Train', 4],
      ['The Station', 5]]);
    const sideStories = await json<{ items: Item[] }>(await stack.call('GET',
      `${contents}?parent=${encodeURIComponent(extras)}`));
    expect(sideStories.items.map(item => [item.label?.value, item.number])).toEqual([['The Cat', null]]);
    const paged = await json<{ items: Item[]; nextCursor: string }>(await stack.call('GET',
      `${contents}?parent=${encodeURIComponent(two)}&limit=1`));
    expect((await json<{ items: Item[] }>(await stack.call('GET', `${contents}?parent=${encodeURIComponent(two)}`
      + `&limit=1&cursor=${paged.nextCursor}`))).items.map(item => item.number)).toEqual([5]);

    // The reader crosses volume boundaries both ways and names the volume and chapter.
    const read = async (occurrence: string) => {
      const before = stack.fuseki.queries;
      const result = await json<Chapter>(await stack.call('GET', `/v1/chapters/${short(occurrence)}`));
      expect(stack.fuseki.queries - before).toBeLessThanOrEqual(READ_QUERIES);
      return result;
    };
    expect(await read(prologue)).toMatchObject({ previous: null, next: letter, number: 1, parentPath: [] });
    expect(await read(ticket)).toMatchObject({ previous: letter, next: train, number: 3,
      parentPath: [{ occurrence: one, division: 'volume', number: 1, label: { value: 'The Rain' } }] });
    expect(await read(train)).toMatchObject({ previous: ticket, next: station, number: 4, ordinal: 1,
      parentPath: [{ occurrence: two, division: 'volume', number: 2 }] });
    expect(await read(station)).toMatchObject({ previous: train, next: cat });
    expect(await read(cat)).toMatchObject({ previous: station, next: null, number: null,
      parentPath: [{ occurrence: extras, division: 'extras', number: null }] });

    // Continue's next chapter after the last of volume one is the first of volume two.
    const visible = async () => true;
    const current = (await stack.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(made.structure)} rv:structureHead ?head } }`)).results!.bindings[0]!.head!.value;
    expect(current).toBe(head);
    const readPage = (occurrence: string) => readCompositionPage(stack.env,
      { structure: made.structure, occurrence, limit: 1, canReadTarget: visible });
    const lastOfOne = (await readPage(ticket)).occurrences[0]!;
    queries = stack.fuseki.queries;
    expect((await nextChapter(stack.env, { structure: made.structure, from: lastOfOne, canReadTarget: visible }))
      ?.record.occurrence).toBe(train);
    // Header once, then one revision query per step: climb, next group, its first chapter.
    expect(stack.fuseki.queries - queries).toBeLessThanOrEqual(2 + 4);
    expect((await nextChapter(stack.env, { structure: made.structure, canReadTarget: visible }))
      ?.record.occurrence).toBe(prologue);
    expect(await nextChapter(stack.env, { structure: made.structure,
      from: (await readPage(cat)).occurrences[0]!, canReadTarget: visible })).toBeNull();

    // Moving a chapter across volumes and reordering volumes renumbers what readers see.
    const moved = await json<{ revision: string }>(await change(head, [{ op: 'move', occurrence: ticket,
      parent: two, position: 'first' }]));
    const reordered = await json<{ revision: string }>(await change(moved.revision, [{ op: 'move',
      occurrence: two, parent: made.structure, position: { after: prologue } }]));
    head = reordered.revision;
    const after = await json<{ items: Item[] }>(await stack.call('GET', contents));
    expect(after.items.map(item => [item.label?.value, item.number, item.childCount])).toEqual([
      ['Prologue', 1, null], ['Book Two: After the Rain', 1, 3], ['The Rain', 2, 1], ['Side Stories', null, 1]]);
    expect(await read(ticket)).toMatchObject({ previous: prologue, next: train, number: 2,
      parentPath: [{ occurrence: two, number: 1 }] });
    expect(await read(letter)).toMatchObject({ previous: station, next: cat, number: 5 });
    // A group empties before it goes; its removal keeps the history.
    const emptied = await json<{ revision: string }>(await change(head, [{ op: 'move', occurrence: letter,
      parent: two, position: 'last' }]));
    const removed = await json<{ revision: string }>(await change(emptied.revision, [{ op: 'remove', occurrence: one }]));
    expect((await json<{ items: Item[] }>(await stack.call('GET', contents))).items.map(item => item.label?.value))
      .toEqual(['Prologue', 'Book Two: After the Rain', 'Side Stories']);
    expect(removed.revision).not.toBe(emptied.revision);
    expect(WORK_CONTENTS_COST.topGroups).toBe(200);
  } finally { await stack.stop(); }
}, 240_000);

test('BOOK02: Continue starts in the first volume and crosses into the next within its read budget', async () => {
  const home = await startHomeStack('continue-volumes');
  try {
    const seeded = await seedHome(home);
    const work = seeded.works[2]!.work;
    const rows = (await home.stack.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      SELECT ?structure ?head ?occurrence ?label WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} rv:mainVersion ?main .
        ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureHead ?head ; rv:selectedGeneration ?generation .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?occurrence ;
          rv:occurrenceRole rv:ChapterRole ; rv:occurrenceLabel ?label .
      } } ORDER BY ?label`)).results?.bindings ?? [];
    expect(rows.map(row => row.label?.value)).toEqual(['Chapter 1', 'Chapter 2']);
    const structure = rows[0]!.structure!.value;
    const [first, second] = rows.map(row => row.occurrence!.value) as [string, string];
    const changes = `/v1/compositions/${short(structure)}/changes`;
    const volumes = await home.json<{ revision: string; occurrences: string[] }>(await home.call('POST', changes, {
      profile: 'book-composition', expectedHead: rows[0]!.head!.value, actingSubject: seeded.author,
      operations: ['Volume One', 'Volume Two'].map(value => ({ op: 'insert', parent: structure, position: 'last',
        role: 'group', label: { value, language: 'en' }, division: 'volume' })) }, home.author.token), 200);
    const [one, two] = volumes.occurrences as [string, string];
    await home.json(await home.call('POST', changes, { profile: 'book-composition',
      expectedHead: volumes.revision, actingSubject: seeded.author, operations: [
        { op: 'move', occurrence: first, parent: one, position: 'last' },
        { op: 'move', occurrence: second, parent: two, position: 'last' }] }, home.author.token), 200);
    const meter = meterStatements();
    try {
      const next = async () => {
        const graph = home.stack.fuseki.queries;
        const statements = meter.count();
        const response = await home.call('GET', seeded.signed('/v1/me/continue'), undefined, home.reader.token);
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(home.stack.fuseki.queries - graph).toBeLessThanOrEqual(HOME_READ_BUDGET.continue.graphQueries);
        expect(meter.count() - statements).toBeLessThanOrEqual(HOME_READ_BUDGET.continue.statements);
        return (JSON.parse(body) as { items: Array<{ work: string; nextUnread: { occurrence: string; title: string | null };
          unreadCount: { kind: string } }> }).items.find(item => item.work === work);
      };
      // Reading, not started: the first chapter sits inside the first volume.
      expect(await next()).toMatchObject({ nextUnread: { occurrence: first, title: 'Chapter 1' } });
      await home.json(await home.call('PUT', `/v1/compositions/${short(structure)}/occurrences/${short(first)}/progress`,
        { actingSubject: seeded.reader, expectedVersion: 0, completed: true, position: null },
        home.reader.token, randomUUID()));
      expect(await next()).toMatchObject({ nextUnread: { occurrence: second, title: 'Chapter 2' },
        unreadCount: { kind: 'lower-bound' } });
      expect(meter.violations).toEqual([]);
    } finally { meter.restore(); }
  } finally { await home.stop(); }
}, 300_000);
