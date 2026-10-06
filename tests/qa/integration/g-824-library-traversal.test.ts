import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { StructureProgressStore, StaleStructureProgress } from '../../../services/main/src/modules/progress/store.ts';
import { prepareLibraryShelves, readShelfMetadata, SHELF_METADATA_COST } from '../../../services/main/src/modules/library/backfill.ts';
import { ReaderLibraryStatusStore, STATUS_SHELF_COST, type ReadingStatus, type ShelfOrder, type ShelfSort }
  from '../../../services/main/src/modules/library/status.ts';
import { meterStatements, startHomeStack } from './feed-read-support.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { fixtureDeadline, fixturePages } from '../../../services/main/tests/g-1009-fixture-guards.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const statuses: ReadingStatus[] = ['want-to-read', 'reading', 'read'];
const sorts: ShelfSort[] = ['added', 'title', 'rating', 'last-read', 'finished'];
// Shelf membership changes append rows that only a co-reader build folds.
const alsoEnjoyedFence = async (pool: Pool) => (await pool.query<{ fence: string }>(`SELECT revision::text
  || ':' || (SELECT count(*) FROM reader.also_enjoyed_source_change)::text AS fence
  FROM reader.also_enjoyed_source_fence WHERE id`)).rows[0]!.fence;
const keys = { added: 'changed_at', title: 'title_key COLLATE "C"', rating: 'own_rating',
  'last-read': 'last_read_at', finished: 'finished_on' };
type Page = { items: { work: string; card: { id: string } | null }[]; nextCursor: string | null };

async function startLibraryStack(label: string) {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access', 'content', 'relay']);
  const original = [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL];
  let home: Awaited<ReturnType<typeof startHomeStack>>;
  try {
    [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL] =
      [databases.urls.access, databases.urls.content, databases.urls.relay];
    home = await startHomeStack(label, { projectionStart: 'current' });
  } catch (error) { await databases.close(); throw error; }
  finally {
    [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL] = original;
  }
  const fixtureSubjects = new Set<string>();
  return { ...home, contentUrl: databases.urls.content, fixtureSubjects, stop: async () => {
    try {
      // Raw scale fixtures have no durable commands. Remove only their subjects
      // so these 1,000 publication pointers cannot enter later global reads.
      const subjects = [...fixtureSubjects];
      for (let offset = 0; offset < subjects.length; offset += 100) {
        await home.stack.fuseki.update(`DELETE { GRAPH ?graph { ?subject ?predicate ?object } } WHERE {
          VALUES ?graph { ${iri(GRAPHS.current)} ${iri(GRAPHS.revisions)} }
          VALUES ?subject { ${subjects.slice(offset, offset + 100).map(iri).join(' ')} }
          GRAPH ?graph { ?subject ?predicate ?object }
        }`);
      }
    } finally { try { await home.stop(); } finally { await databases.close(); } }
  } };
}

/** Large owner fixture, intentionally made in bounded batches. Publication
 * pointers have the same read shape as a command-created metadata Work; the
 * reader/authority boundary is provisioned through the real API. */
async function publishFixture(home: Awaited<ReturnType<typeof startLibraryStack>>, works: string[]) {
  for (let offset = 0; offset < works.length; offset += 50) {
    const fixtures = works.slice(offset, offset + 50).map((work, i) => ({ work,
      main: id(), head: id(), contribution: id(), decision: id(), draft: id(), selection: id(),
      title: `Shelf title ${String((offset + i) % 30).padStart(2, '0')}` }));
    for (const fixture of fixtures) for (const subject of [fixture.work, fixture.main, fixture.head,
      fixture.contribution, fixture.decision, fixture.draft, fixture.selection]) home.fixtureSubjects.add(subject);
    await home.stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${fixtures.map(f => `${iri(f.work)} a schema:CreativeWork ; rv:mainVersion ${iri(f.main)} ;
          rv:head ${iri(f.head)} ; rdfs:label ${lit(f.title)}@en .
          ${iri(f.main)} a rv:MainVersion ; rv:work ${iri(f.work)} ; rv:selectionHead ${iri(f.selection)} .
          ${iri(f.contribution)} rv:work ${iri(f.work)} ; rv:publicationHead ${iri(f.decision)} .`).join('\n')}
      } GRAPH ${iri(GRAPHS.revisions)} {
        ${fixtures.map(f => `${iri(f.selection)} a rv:PublicationSelection ; rv:work ${iri(f.work)} ;
          rv:mainVersion ${iri(f.main)} ; rv:contribution ${iri(f.contribution)} ;
          rv:publicationDecision ${iri(f.decision)} ; rv:selectedDraft ${iri(f.draft)} .
          ${iri(f.decision)} a rv:PublicationDecision ; rv:component ${iri(f.contribution)} ;
          rv:work ${iri(f.work)} ; rv:contribution ${iri(f.contribution)} ; rv:disclosure rv:Public ;
          rv:selectedDraft ${iri(f.draft)} .
          ${iri(f.draft)} a rv:RevisionAnchor ; rv:component ${iri(f.contribution)} .`).join('\n')}
      } }`);
  }
}

test('G-824: 1,000 Works traverse each status in every SQL sort/direction without gaps; cursors fence concurrent moves', async () => {
  const home = await startLibraryStack('g-824-traversal');
  try {
    const agent = await home.provision('Shelf traversal reader', home.reader.token);
    const works = Array.from({ length: 1_000 }, id);
    await publishFixture(home, works);
    await home.stack.contentPool.query(`INSERT INTO reader.library_status
      (agent, work, status, version, changed_at, title_key, own_rating, last_read_at, finished_on)
      SELECT $1, work, (ARRAY['want-to-read','reading','read'])[1 + ordinal::int % 3], 1,
        '2026-01-01'::timestamptz + (ordinal % 40) * interval '1 second',
        CASE WHEN ordinal % 7 != 0 THEN 'title-' || lpad((ordinal % 30)::text,2,'0') END,
        CASE WHEN ordinal % 4 != 0 THEN 1 + ordinal::int % 5 END,
        CASE WHEN ordinal % 5 != 0 THEN '2026-01-01'::timestamptz + (ordinal % 25) * interval '1 second' END,
        CASE WHEN ordinal % 3 = 2 AND ordinal % 4 != 0 THEN '2026-02-01'::date + (ordinal % 20)::int END
      FROM unnest($2::text[]) WITH ORDINALITY AS fixture(work,ordinal)`, [agent, works]);
    const signed = (path: string) => `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(agent)}`;
    const meter = meterStatements();
    try {
      const before = meter.count();
      const counts = await home.deps.libraryStatus.shelves(agent);
      expect(meter.count() - before).toBe(STATUS_SHELF_COST.countStatements);
      expect(counts.reduce((sum, row) => sum + row.count, 0)).toBe(1_000);
      await home.stack.contentPool.query('ANALYZE reader.library_status');
      for (const sort of sorts) for (const order of ['asc', 'desc']) {
        type Plan = { 'Node Type': string; Plans?: Plan[]; 'Actual Rows': number };
        const plan = (await home.stack.contentPool.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(`
          EXPLAIN (ANALYZE, FORMAT JSON) SELECT work FROM reader.library_status
          WHERE agent=$1 AND status='read' AND ${keys[sort]} IS NOT NULL
          ORDER BY ${keys[sort]} ${order}, work ${order} LIMIT 20`, [agent])).rows[0]!['QUERY PLAN'][0]!.Plan;
        const nodes = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
        expect(nodes(plan).some(node => node['Node Type'].includes('Index'))).toBe(true);
        expect(nodes(plan).some(node => ['Sort', 'Seq Scan'].includes(node['Node Type']))).toBe(false);
        expect(Math.max(...nodes(plan).map(node => node['Actual Rows']))).toBeLessThanOrEqual(20);
      }
      for (const status of statuses) for (const sort of sorts.filter(sort => sort !== 'finished' || status === 'read')) {
        for (const order of ['asc', 'desc'] as ShelfOrder[]) {
          const expected = (await home.stack.contentPool.query<{ work: string }>(`SELECT work
            FROM reader.library_status WHERE agent = $1 AND status = $2
            ORDER BY ${keys[sort]} ${order} NULLS LAST, work ${order}`, [agent, status])).rows.map(row => row.work);
          const actual: string[] = [];
          const stage = `G-824 owned ${status}/${sort}/${order}`;
          const recordPage = fixturePages(stage, expected.length);
          let cursor: string | null = null;
          do {
            const path = `/v1/me/shelves/status/${status}/works?sort=${sort}&order=${order}&limit=20`
              + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
            const page = await fixtureDeadline(home.call('GET', signed(path), undefined, home.reader.token)
              .then(response => home.json<Page>(response)), stage);
            recordPage(page.items.map(item => item.work), page.nextCursor);
            expect(page.items.length).toBeGreaterThan(0);
            expect(page.items.length).toBeLessThanOrEqual(20);
            expect(page.items.every(item => item.card?.id === item.work)).toBe(true);
            actual.push(...page.items.map(item => item.work));
            cursor = page.nextCursor;
          } while (cursor);
          expect(new Set(actual).size).toBe(actual.length);
          expect(actual).toEqual(expected);
          expect(actual.length).toBe(counts.find(row => row.status === status)!.count);
        }
      }
      await home.json(await home.call('PUT', `/v1/agents/${agent.slice(-36)}/library-visibility`,
        { visibility: 'public', expectedVersion: 0 }, home.reader.token));
      const publicCounts = await home.json<{ statusShelves: { status: string; count: number; countKind: string; nextCursor: string | null }[] }>(
        await home.call('GET', `/v1/agents/${agent.slice(-36)}/shelves`));
      expect(publicCounts.statusShelves.reduce((sum, shelf) => sum + shelf.count, 0)).toBe(60);
      expect(publicCounts.statusShelves.every(shelf => shelf.countKind === 'lower-bound' && shelf.nextCursor)).toBe(true);
      const publicPage = await home.json<Page & { statusCount: number }>(await home.call('GET',
        `/v1/agents/${agent.slice(-36)}/shelves/status/read/works?sort=title&order=asc&limit=20`));
      expect(publicPage.items).toHaveLength(20);
      for (const sort of ['rating', 'last-read', 'finished']) {
        expect((await home.call('GET', `/v1/agents/${agent.slice(-36)}/shelves/status/read/works?sort=${sort}`)).status)
          .toBe(400);
      }
      expect(publicPage).toMatchObject({ statusCount: 20, statusCountKind: 'lower-bound' });
      const sharedBase = `/v1/agents/${agent.slice(-36)}/shelves/status/read/works?sort=title&order=asc&limit=20`;
      const scans = spyOn(home.deps.libraryStatus, 'sortedPage');
      try {
        const sharedWorks = publicPage.items.map(item => item.work);
        const expectedPublicCount = counts.find(shelf => shelf.status === 'read')!.count;
        const recordPage = fixturePages('G-824 public read/title/asc', expectedPublicCount);
        recordPage(sharedWorks, publicPage.nextCursor);
        let sharedCursor = publicPage.nextCursor;
        while (sharedCursor) {
          scans.mockClear();
          const graphBefore = home.stack.fuseki.queries;
          const page = await fixtureDeadline(home.call('GET', `${sharedBase}&cursor=${encodeURIComponent(sharedCursor)}`)
            .then(response => home.json<Page & { statusCount: number; statusCountKind: string }>(response)), 'G-824 public read/title/asc');
          recordPage(page.items.map(item => item.work), page.nextCursor);
          expect(page.statusCount).toBe(sharedWorks.length + page.items.length);
          expect(page.statusCountKind).toBe(page.nextCursor ? 'lower-bound' : 'approximate');
          // Two candidate batches at most (including lookahead); no count scan.
          expect(scans.mock.calls.length).toBeLessThanOrEqual(2);
          expect(scans.mock.calls.every(call => call[2] === STATUS_SHELF_COST.candidateBatch)).toBe(true);
          expect(home.stack.fuseki.queries - graphBefore).toBeLessThan(25);
          sharedWorks.push(...page.items.map(item => item.work));
          sharedCursor = page.nextCursor;
        }
        expect(new Set(sharedWorks).size).toBe(expectedPublicCount);
        expect(sharedWorks).toHaveLength(expectedPublicCount);
      } finally { scans.mockRestore(); }
      const tampered = `${publicPage.nextCursor!.startsWith('A') ? 'B' : 'A'}${publicPage.nextCursor!.slice(1)}`;
      expect((await home.call('GET', `${sharedBase}&cursor=${tampered}`)).status).toBe(400);
      const base = '/v1/me/shelves/status/read/works?sort=rating&order=desc&limit=3';
      const first = await home.json<Page>(await home.call('GET', signed(base), undefined, home.reader.token));
      expect(first.nextCursor).not.toBeNull();
      const continuation = signed(`${base}&cursor=${encodeURIComponent(first.nextCursor!)}`);
      const switched = continuation.replace('sort=rating', 'sort=title');
      expect((await home.call('GET', switched, undefined, home.reader.token)).status).toBe(400);
      // A returned row is moved to another shelf and back with a new key. The
      // old continuation rejects rather than duplicating it later in the scan.
      const work = first.items[0]!.work;
      await home.deps.libraryStatus.write({ agent, work, status: 'reading', expectedVersion: 1,
        idempotencyKey: randomUUID() });
      await home.deps.libraryStatus.write({ agent, work, status: 'read', expectedVersion: 2,
        idempotencyKey: randomUUID() });
      expect((await home.call('GET', continuation, undefined, home.reader.token)).status).toBe(409);
      expect((await home.call('GET', `${sharedBase}&cursor=${encodeURIComponent(publicPage.nextCursor!)}`)).status).toBe(409);
      const next = await home.json<Page>(await home.call('GET', signed(base), undefined, home.reader.token));
      await home.deps.libraryStatus.projectRating(agent, next.items[0]!.work, 1);
      expect((await home.call('GET', signed(`${base}&cursor=${encodeURIComponent(next.nextCursor!)}`),
        undefined, home.reader.token)).status).toBe(409);
      expect((await home.call('GET', signed('/v1/me/shelves/status/reading/works?sort=finished'),
        undefined, home.reader.token)).status).toBe(400);
      expect((await home.call('GET', signed(base), undefined, home.author.token)).status).toBe(403);
      const totals = await home.json<{ books: number; detailsAvailability: string }>(await home.call('GET',
        signed('/v1/me/reading-stats?year=2026'), undefined, home.reader.token));
      expect(totals.books).toBe(250);
      expect(totals.detailsAvailability).toBe('unavailable');
      expect((await home.call('GET', signed('/v1/me/reading-stats/summary?year=2026'),
        undefined, home.reader.token)).status).toBe(404);
    } finally { meter.restore(); }
  } finally { await home.stop(); }
}, 240_000);

test('G-824: frozen chapter rows backfill once; owner placeholders match counts and public shelves skip them', async () => {
  const home = await startLibraryStack('g-824-backfill');
  try {
    const agent = await home.provision('Backfill reader', home.reader.token);
    const parent = await home.stack.publicWork(agent, ['en'], 'Backfill parent');
    const child = id();
    home.fixtureSubjects.add(child);
    await home.stack.contentPool.query(`INSERT INTO reader.library_status
      (agent,work,status,version,title_key) VALUES ($1,$2,'reading',3,'')`, [agent, child]);
    await prepareLibraryShelves(home.stack.contentPool, home.stack.accessPool, home.stack.fuseki);
    await home.deps.libraryStatus.write({ agent, work: parent.work, status: 'reading',
      expectedVersion: 0, idempotencyKey: randomUUID() });
    expect(await home.deps.libraryStatus.batch(agent, [parent.work, child])).toMatchObject([
      { work: parent.work, status: 'reading', version: 1 }, { work: child, status: 'reading', version: 3 }]);
    const snapshot = await home.deps.libraryStatus.fence(agent);
    await prepareLibraryShelves(home.stack.contentPool, home.stack.accessPool, home.stack.fuseki);
    expect(await home.deps.libraryStatus.fence(agent)).toBe(snapshot);
    // Owners retain unavailable identities, including a prefix beyond the old
    // 240-row bound. Public counts/page membership exclude these placeholders.
    const unavailable = Array.from({ length: 245 }, id);
    await home.stack.contentPool.query(`INSERT INTO reader.library_status
      (agent,work,status,version,changed_at) SELECT $1,work,'reading',1,'2099-01-01'
      FROM unnest($2::text[]) fixture(work)`, [agent, unavailable]);
    const ownBase = `/v1/me/shelves/status/reading/works?actingSubject=${encodeURIComponent(agent)}&limit=20`;
    const owned: Page['items'] = [];
    const recordPage = fixturePages('G-824 owner placeholders', unavailable.length + 2);
    let cursor: string | null = null;
    do {
      const page = await fixtureDeadline(home.call('GET', ownBase
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''), undefined, home.reader.token)
        .then(response => home.json<Page>(response)), 'G-824 owner placeholders');
      recordPage(page.items.map(item => item.work), page.nextCursor);
      owned.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(owned).toHaveLength(247);
    expect(new Set(owned.map(item => item.work)).size).toBe(247);
    expect(owned.filter(item => !item.card).map(item => item.work).sort()).toEqual([...unavailable, child].sort());
    expect(owned.find(item => item.work === parent.work)?.card?.id).toBe(parent.work);
    expect((await home.deps.libraryStatus.shelves(agent)).find(row => row.status === 'reading')?.count).toBe(owned.length);
    await home.json(await home.call('PUT', `/v1/agents/${agent.slice(-36)}/library-visibility`,
      { visibility: 'public', expectedVersion: 0 }, home.reader.token));
    const publicBase = `/v1/agents/${agent.slice(-36)}/shelves/status/reading/works?limit=1`;
    // Invisible prefixes advance in bounded empty pages. Count only delivered
    // cards and follow the cursor until the lagging total finishes.
    const publicTraversal = async () => {
      const works: Page['items'] = [];
      let cursor: string | null = null, pages = 0;
      let page: Page & { statusCount: number; statusCountKind: string };
      do {
        const scans = spyOn(home.deps.libraryStatus, 'sortedPage');
        try {
          page = await home.json<typeof page>(await home.call('GET', publicBase
            + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')));
          expect(scans.mock.calls.length).toBeLessThanOrEqual(STATUS_SHELF_COST.candidateBatches);
        } finally { scans.mockRestore(); }
        works.push(...page.items);
        expect(page.statusCount).toBe(works.length);
        cursor = page.nextCursor;
        expect(++pages).toBeLessThanOrEqual(8);
      } while (cursor);
      return { ...page, items: works };
    };
    const shared = await publicTraversal();
    expect(shared.items.map(item => item.work)).toEqual([parent.work]);
    expect(shared).toMatchObject({ statusCount: 1, statusCountKind: 'approximate', nextCursor: null });
    // A publication pointer alone is insufficient: a missing display name also
    // makes the card unavailable, and the public total must agree with its page.
    await home.stack.fuseki.update(`PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      DELETE WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(parent.work)} rdfs:label ?label } }`);
    const nameless = await publicTraversal();
    expect(nameless).toMatchObject({ items: [], statusCount: 0, nextCursor: null });
    const namelessCounts = await home.json<{ statusShelves: { status: string; count: number }[] }>(
      await home.call('GET', `/v1/agents/${agent.slice(-36)}/shelves`));
    expect(namelessCounts.statusShelves.find(row => row.status === 'reading')?.count).toBe(0);
    await home.stack.fuseki.update(`PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(parent.work)} rdfs:label "Backfill parent"@en } }`);
    const empty = await home.json<Page>(await home.call('GET',
      `/v1/me/shelves/status/read/works?actingSubject=${encodeURIComponent(agent)}`, undefined, home.reader.token));
    expect(empty).toMatchObject({ items: [], nextCursor: null });
    const state = await home.deps.libraryStatus.batch(agent, [parent.work]);
    const result = await home.json(await home.call('PUT', `/v1/works/${parent.work.slice(-36)}/reader-status`,
      { actingSubject: agent, status: 'read', expectedVersion: state[0]!.version }, home.reader.token));
    expect(result).toMatchObject({ status: 'read' });
    const meter = meterStatements();
    try {
      const graphCalls = home.stack.fuseki.queries, sqlReads = meter.count();
      expect(await readShelfMetadata(home.stack.contentPool, home.stack.accessPool,
        home.stack.fuseki, agent, parent.work)).toMatchObject({ titleKey: 'backfill parent' });
      expect(home.stack.fuseki.queries - graphCalls).toBeLessThanOrEqual(SHELF_METADATA_COST.graphCalls);
      expect(meter.count() - sqlReads).toBeLessThanOrEqual(SHELF_METADATA_COST.sqlReads);
    } finally { meter.restore(); }
    const coReaderFence = await alsoEnjoyedFence(home.stack.contentPool);
    await home.stack.contentPool.query(`UPDATE reader.library_status SET own_rating=5,
      title_key='new key' WHERE agent=$1 AND work=$2`, [agent, parent.work]);
    expect(await alsoEnjoyedFence(home.stack.contentPool)).toBe(coReaderFence);
    await home.deps.libraryStatus.projectRating(agent, parent.work, null);
    expect(await alsoEnjoyedFence(home.stack.contentPool)).toBe(coReaderFence);
    const current = (await home.deps.libraryStatus.batch(agent, [parent.work]))[0]!;
    await home.deps.libraryStatus.write({ agent, work: parent.work, status: 'read',
      finishedOn: '2026-05-01', expectedVersion: current.version, idempotencyKey: randomUUID() });
    expect(await alsoEnjoyedFence(home.stack.contentPool)).toBe(coReaderFence);
    const progress = new StructureProgressStore(home.stack.contentPool);
    const statusFence = await home.deps.libraryStatus.fence(agent);
    const progressFence = await home.deps.libraryStatus.fence(agent, 'last-read');
    const input = { principal: home.reader.principal, structure: id(), occurrence: id(), completed: false,
      position: 'paragraph-1', expectedVersion: 0, idempotencyKey: randomUUID(), library: { agent, work: parent.work } };
    const saved = await progress.write(input);
    expect(await home.deps.libraryStatus.fence(agent)).toBe(statusFence);
    expect(await home.deps.libraryStatus.fence(agent, 'last-read')).not.toBe(progressFence);
    expect(await alsoEnjoyedFence(home.stack.contentPool)).toBe(coReaderFence);
    const lastReadFence = await home.deps.libraryStatus.fence(agent, 'last-read');
    expect(await progress.write(input)).toEqual({ ...saved, replayed: true });
    expect(await home.deps.libraryStatus.fence(agent, 'last-read')).toBe(lastReadFence);
    await expect(progress.write({ ...input, position: 'paragraph-2', idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(StaleStructureProgress);
    expect(await home.deps.libraryStatus.fence(agent, 'last-read')).toBe(lastReadFence);
    expect((await home.stack.contentPool.query<{ title_key: string }>(`SELECT title_key FROM reader.library_status
      WHERE agent=$1 AND work=$2`, [agent, parent.work])).rows[0]!.title_key).toBe('backfill parent');
    // Metadata reads reuse the write's connection: a one-connection Content
    // pool must complete concurrent writers rather than queue behind itself.
    // Bound the pool queue as well: a nested acquisition must release its
    // transaction on failure, so cleanup cannot wait behind that same holder.
    const single = new Pool({ connectionString: home.contentUrl, max: 1,
      connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
    try {
      await prepareLibraryShelves(single, home.stack.accessPool, home.stack.fuseki);
      const store = new ReaderLibraryStatusStore(single);
      const results = await fixtureDeadline(Promise.all(Array.from({ length: 4 }, () => store.write({ agent,
        work: id(), status: 'want-to-read', expectedVersion: 0, idempotencyKey: randomUUID() }))),
      'G-824 concurrent one-connection Content writers');
      expect(results.every(result => result.version === 1)).toBe(true);
    } finally { await single.end(); }

  } finally { await home.stop(); }
}, 120_000);


test('G-824: background backfill isolates graph and SQL failures, serves reads, and retries only pending rows', async () => {
  const home = await startLibraryStack('g-824-backfill-recovery');
  try {
    const agent = await home.provision('Backfill recovery reader', home.reader.token);
    const healthy = Array.from({ length: 30 }, id).sort(), badWrite = id(), badMetadata = id(), badParent = id();
    await publishFixture(home, [...healthy, badWrite]);
    const extraMain = id(), retainedMain = id();
    home.fixtureSubjects.add(badParent);
    home.fixtureSubjects.add(badMetadata);
    await home.stack.fuseki.update(`PREFIX schema: <https://schema.org/> PREFIX rv: <https://rezics.com/vocab/>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(badMetadata)} rv:mainVersion ${iri(retainedMain)}, ${iri(extraMain)} . } }`);
    await home.stack.contentPool.query(`INSERT INTO reader.library_status
      (agent,work,status,version,title_key,changed_at) SELECT $1,work,'reading',1,'','2026-01-01'
      FROM unnest($2::text[]) fixture(work)`, [agent, [...healthy, badWrite, badMetadata, badParent]]);
    // Equal timestamps/work keys on different agents still drain across batches.
    await home.stack.contentPool.query(`INSERT INTO reader.library_status
      (agent,work,status,version,title_key,changed_at) VALUES ($1,$2,'reading',1,'','2026-01-01')`, [id(), healthy[0]]);
    await home.stack.contentPool.query(`CREATE FUNCTION reader.g824_reject_backfill() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.work = '${badWrite}' THEN RAISE EXCEPTION 'G-824 injected row failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER g824_reject_backfill BEFORE UPDATE ON reader.library_status
      FOR EACH ROW EXECUTE FUNCTION reader.g824_reject_backfill()`);
    const errors: string[] = [];
    const onRowError = (row: { work: string }) => { errors.push(row.work); };
    let entered!: () => void, resume!: () => void;
    const enteredGraph = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const graph = home.stack.fuseki;
    const original = graph.query.bind(graph);
    let first = true;
    const pendingWork = healthy[1]!; // Only this Agent owns this Work's frozen row.
    const paused = spyOn(graph, 'query').mockImplementation(async (...args) => {
      if (first && args[0].includes('SELECT ?main ?label ?structure') && args[0].includes(iri(pendingWork))) {
        first = false;
        entered(); await gate;
      }
      return original(...args);
    });
    const before = await alsoEnjoyedFence(home.stack.contentPool);
    const pending = prepareLibraryShelves(home.stack.contentPool, home.stack.accessPool, graph, { onRowError });
    try {
      await fixtureDeadline(Promise.race([enteredGraph, pending.then(() => {
        throw new Error(`G-824 backfill finished without reading its owned Work ${pendingWork}`);
      })]), `G-824 backfill metadata read for ${pendingWork}`);
      // A blocked migration read cannot hold Main's reader endpoints hostage.
      expect((await home.call('GET', `/v1/me/shelves?actingSubject=${encodeURIComponent(agent)}`,
        undefined, home.reader.token)).status).toBe(200);
      // The backfill holds the same per-Work lock as live rating/progress
      // writers throughout metadata read and commit, preventing lost updates.
      expect((await home.stack.contentPool.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
        [JSON.stringify(['library-status-work', agent, pendingWork])])).rows[0]!.locked).toBe(false);
    } finally {
      resume();
      try { await fixtureDeadline(pending, 'G-824 resumed backfill'); } finally { paused.mockRestore(); }
    }
    expect(errors.sort()).toEqual([badWrite, badMetadata].sort());
    expect((await home.stack.contentPool.query<{ count: string }>(`SELECT count(*)::text FROM reader.library_status
      WHERE agent=$1 AND title_key=''`, [agent])).rows[0]!.count).toBe('2');
    expect(await alsoEnjoyedFence(home.stack.contentPool)).toBe(before);
    const snapshot = await home.deps.libraryStatus.fence(agent);
    errors.length = 0;
    await prepareLibraryShelves(home.stack.contentPool, home.stack.accessPool, graph, { onRowError });
    expect(errors.sort()).toEqual([badWrite, badMetadata].sort());
    expect(await home.deps.libraryStatus.fence(agent)).toBe(snapshot);
    await home.stack.contentPool.query('DROP TRIGGER g824_reject_backfill ON reader.library_status; DROP FUNCTION reader.g824_reject_backfill()');
    await graph.update(`PREFIX schema: <https://schema.org/> PREFIX rv: <https://rezics.com/vocab/>
      DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(badMetadata)} rv:mainVersion ${iri(extraMain)} . } }`);
    errors.length = 0;
    await prepareLibraryShelves(home.stack.contentPool, home.stack.accessPool, graph, { onRowError });
    expect(errors).toEqual([]);
    expect((await home.stack.contentPool.query<{ count: string }>(`SELECT count(*)::text FROM reader.library_status
      WHERE agent=$1 AND title_key=''`, [agent])).rows[0]!.count).toBe('0');
    expect((await home.deps.libraryStatus.batch(agent, [badParent]))[0]).toMatchObject({ status: 'reading', version: 1 });
    expect([...(await home.deps.libraryStatus.batch(agent, healthy.slice(0, 20))),
      ...(await home.deps.libraryStatus.batch(agent, healthy.slice(20)))]
      .every(row => row.status === 'reading' && row.version === 1)).toBe(true);
    // Metadata backfill preserves the private status and its membership fence.
    expect(await alsoEnjoyedFence(home.stack.contentPool)).toBe(before);
    const final = await home.deps.libraryStatus.fence(agent);
    await prepareLibraryShelves(home.stack.contentPool, home.stack.accessPool, graph, { onRowError });
    expect(await home.deps.libraryStatus.fence(agent)).toBe(final);
    const lock = await home.stack.contentPool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended('library-shelves-602',0))");
      await prepareLibraryShelves(home.stack.contentPool, home.stack.accessPool, graph, { onRowError });
      expect(await home.deps.libraryStatus.fence(agent)).toBe(final);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended('library-shelves-602',0))");
      lock.release();
    }
  } finally { await home.stop(); }
}, 120_000);
