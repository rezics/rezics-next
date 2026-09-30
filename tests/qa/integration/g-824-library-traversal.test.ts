import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { StructureProgressStore, StaleStructureProgress } from '../../../services/main/src/modules/progress/store.ts';
import { prepareLibraryShelves, readShelfMetadata, SHELF_METADATA_COST } from '../../../services/main/src/modules/library/backfill.ts';
import { ReaderLibraryStatusStore, STATUS_SHELF_COST, type ReadingStatus, type ShelfOrder, type ShelfSort }
  from '../../../services/main/src/modules/library/status.ts';
import { meterStatements, startHomeStack } from './feed-read-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const statuses: ReadingStatus[] = ['want-to-read', 'reading', 'read'];
const sorts: ShelfSort[] = ['added', 'title', 'rating', 'last-read', 'finished'];
const keys = { added: 'changed_at', title: 'title_key COLLATE "C"', rating: 'own_rating',
  'last-read': 'last_read_at', finished: 'finished_on' };
type Page = { items: { work: string; card: { id: string } }[]; nextCursor: string | null };

/** Large owner fixture, intentionally made in bounded batches. Publication
 * pointers have the same read shape as a command-created metadata Work; the
 * reader/authority boundary is provisioned through the real API. */
async function publishFixture(home: Awaited<ReturnType<typeof startHomeStack>>, works: string[]) {
  for (let offset = 0; offset < works.length; offset += 50) {
    const fixtures = works.slice(offset, offset + 50).map((work, i) => ({ work,
      main: id(), head: id(), contribution: id(), decision: id(), draft: id(), selection: id(),
      title: `Shelf title ${String((offset + i) % 30).padStart(2, '0')}` }));
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
  const home = await startHomeStack('g-824-traversal');
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
          let cursor: string | null = null;
          do {
            const path = `/v1/me/shelves/status/${status}/works?sort=${sort}&order=${order}&limit=20`
              + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
            const page = await home.json<Page>(await home.call('GET', signed(path), undefined, home.reader.token));
            expect(page.items.length).toBeGreaterThan(0);
            expect(page.items.length).toBeLessThanOrEqual(20);
            expect(page.items.every(item => item.card.id === item.work)).toBe(true);
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
      const publicCounts = await home.json<{ statusShelves: { status: string; count: number }[] }>(
        await home.call('GET', `/v1/agents/${agent.slice(-36)}/shelves`));
      expect(publicCounts.statusShelves.reduce((sum, shelf) => sum + shelf.count, 0)).toBe(1_000);
      const publicPage = await home.json<Page & { statusCount: number }>(await home.call('GET',
        `/v1/agents/${agent.slice(-36)}/shelves/status/read/works?sort=title&order=asc&limit=20`));
      expect(publicPage.items).toHaveLength(20);
      for (const sort of ['rating', 'last-read', 'finished']) {
        expect((await home.call('GET', `/v1/agents/${agent.slice(-36)}/shelves/status/read/works?sort=${sort}`)).status)
          .toBe(400);
      }
      expect(publicPage.statusCount).toBe(counts.find(shelf => shelf.status === 'read')!.count);
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
}, 600_000);

test('G-824: frozen chapter rows backfill once; missing cards never truncate the keyset', async () => {
  const home = await startHomeStack('g-824-backfill');
  try {
    const agent = await home.provision('Backfill reader', home.reader.token);
    const parent = await home.stack.publicWork(agent, ['en'], 'Backfill parent');
    const child = id();
    await home.stack.fuseki.update(`PREFIX schema: <https://schema.org/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(child)} schema:isPartOf ${iri(parent.work)} } }`);
    await home.stack.contentPool.query(`INSERT INTO reader.library_status
      (agent,work,status,version,title_key) VALUES ($1,$2,'reading',3,'')`, [agent, child]);
    await prepareLibraryShelves(home.stack.contentPool, home.stack.accessPool, home.stack.fuseki);
    expect(await home.deps.libraryStatus.batch(agent, [parent.work, child])).toMatchObject([
      { work: parent.work, status: 'reading', version: 1 }, { work: child, status: null, version: 4 }]);
    const snapshot = await home.deps.libraryStatus.fence(agent);
    await prepareLibraryShelves(home.stack.contentPool, home.stack.accessPool, home.stack.fuseki);
    expect(await home.deps.libraryStatus.fence(agent)).toBe(snapshot);
    // An unavailable prefix larger than the old 240 candidate bound is skipped
    // within one read budget. The published parent still fills the next page.
    await home.stack.contentPool.query(`INSERT INTO reader.library_status
      (agent,work,status,version,changed_at) SELECT $1,work,'reading',1,'2099-01-01'
      FROM unnest($2::text[]) fixture(work)`, [agent, Array.from({ length: 245 }, id)]);
    const page = await home.json<Page>(await home.call('GET',
      `/v1/me/shelves/status/reading/works?actingSubject=${encodeURIComponent(agent)}&limit=1`,
      undefined, home.reader.token));
    expect(page.items.map(item => item.work)).toEqual([parent.work]);
    expect(page.nextCursor).toBeNull();
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
    const progress = new StructureProgressStore(home.stack.contentPool);
    const statusFence = await home.deps.libraryStatus.fence(agent);
    const progressFence = await home.deps.libraryStatus.fence(agent, 'last-read');
    const input = { principal: home.reader.principal, structure: id(), occurrence: id(), completed: false,
      position: 'paragraph-1', expectedVersion: 0, idempotencyKey: randomUUID(), library: { agent, work: parent.work } };
    const saved = await progress.write(input);
    expect(await home.deps.libraryStatus.fence(agent)).toBe(statusFence);
    expect(await home.deps.libraryStatus.fence(agent, 'last-read')).not.toBe(progressFence);
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
    const single = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 1 });
    try {
      await prepareLibraryShelves(single, home.stack.accessPool, home.stack.fuseki);
      const store = new ReaderLibraryStatusStore(single);
      const results = await Promise.all(Array.from({ length: 4 }, () => store.write({ agent,
        work: id(), status: 'want-to-read', expectedVersion: 0, idempotencyKey: randomUUID() })));
      expect(results.every(result => result.version === 1)).toBe(true);
    } finally { await single.end(); }

  } finally { await home.stop(); }
}, 600_000);
