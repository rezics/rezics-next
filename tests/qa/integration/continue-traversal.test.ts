import { expect, test } from 'bun:test';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { HOME_READ_BUDGET, meterStatements, seedHome, startHomeStack } from './feed-read-support.ts';

type Page = { items: { work: string }[]; nextCursor: string | null; complete: boolean;
  scanned: { reading: number; followed: number } };

test('Continue traverses long reading and follow inventories, with private cursors and bounded page cost at three sizes', async () => {
  const home = await startHomeStack('continue-traversal', { projectionStart: 'current' });
  try {
    const seeded = await seedHome(home);
    const book = seeded.works[2]!.work;
    const rows = (await home.stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/> SELECT ?target WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(book)} rv:mainVersion ?main . ?structure rv:structureOf ?main ; rv:selectedGeneration ?generation .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ?target . } } LIMIT 1`)).results!.bindings;
    const target = rows[0]!.target!.value;
    const expected = new Set([book]);
    const costs: { population: number; graph: number; sql: number; bytes: number }[] = [];
    const read = (cursor?: string, token = home.reader.token, agent = seeded.reader) => home.call('GET',
      `/v1/me/continue?${new URLSearchParams({ actingSubject: agent, limit: '3', ...(cursor ? { cursor } : {}) })}`,
      undefined, token);
    let total = 1;
    for (const population of [4, 12, 24]) {
      for (; total < population; total++) {
        const work = await home.stack.publicWork(seeded.author, ['en'], `Continue Book ${total}`);
        const client = await home.stack.accessPool.connect();
        try {
          await client.query('BEGIN');
          await grantFixtureAuthority(client, { scope: `work:edit:${work.work}`, requireDispatch: true,
            representations: [{ principalId: home.author.principalId, actor: seeded.author, action: 'work.edit', lifetime: '1 hour' }],
            grant: { actor: seeded.author, action: 'work.edit', lifetime: '1 hour' } });
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        const head = (await home.stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } }`))
          .results!.bindings[0]!.head!.value;
        await home.json(await home.call('PUT', `/v1/works/${work.work.slice(-36)}/type`, {
          profile: 'work-type-v2', expectedHead: head, types: ['https://schema.org/Book'],
          actingSubject: seeded.author }, home.author.token));
        const composition = await home.json<{ structure: string; revision: string }>(await home.call('POST', '/v1/compositions', {
          profile: 'book-composition', work: work.work, mainVersion: work.mainVersion,
          actingSubject: seeded.author }, home.author.token), 201);
        await home.json(await home.call('POST', `/v1/compositions/${composition.structure.slice(-36)}/changes`, {
          profile: 'book-composition', expectedHead: composition.revision, actingSubject: seeded.author,
          operations: [{ op: 'insert', parent: composition.structure, position: 'last', role: 'chapter', target,
            label: { value: 'Chapter 1', language: 'en' } }] }, home.author.token));
        await home.json(await home.call('POST', '/v1/follows', { profile: 'follow-command-v1',
          actingSubject: seeded.reader, following: true, expectedRevision: null, target: work.work,
          kind: 'work' }, home.reader.token));
        if (total % 2) await home.json(await home.call('PUT', `/v1/works/${work.work.slice(-36)}/reader-status`, {
          actingSubject: seeded.reader, expectedVersion: 0, status: 'reading', startedOn: null, finishedOn: null,
        }, home.reader.token));
        expected.add(work.work);
      }
      const meter = meterStatements();
      try {
        let cursor: string | undefined;
        const seen: string[] = [];
        for (let pageNumber = 0; pageNumber < population * 2; pageNumber++) {
          const graph = home.stack.fuseki.queries, sql = meter.count();
          const response = await read(cursor);
          const text = await response.text();
          expect(response.status).toBe(200);
          const page = JSON.parse(text) as Page;
          const cost = { population, graph: home.stack.fuseki.queries - graph,
            sql: meter.count() - sql, bytes: Buffer.byteLength(text) };
          costs.push(cost);
          expect(cost.graph).toBeLessThanOrEqual(HOME_READ_BUDGET.continue.graphQueries);
          expect(cost.sql).toBeLessThanOrEqual(HOME_READ_BUDGET.continue.statements);
          expect(cost.bytes).toBeLessThanOrEqual(64 * 1024);
          expect(page.scanned.reading + page.scanned.followed).toBeLessThanOrEqual(3);
          expect(page.complete).toBe(page.nextCursor === null);
          seen.push(...page.items.map(item => item.work));
          if (!page.nextCursor) { cursor = undefined; break; }
          expect(page.nextCursor).not.toBe(cursor);
          cursor = page.nextCursor;
        }
        expect(cursor).toBeUndefined();
        expect(new Set(seen)).toEqual(expected);
        expect(seen.length).toBe(expected.size);
        expect(meter.violations).toEqual([]);
      } finally { meter.restore(); }
    }
    console.log(JSON.stringify({ label: 'continue-inventory-growth', costs }));
    const first = await home.json<Page>(await read());
    expect(first.nextCursor).not.toBeNull();
    const stranger = await home.member('continue-stranger');
    const strangerAgent = await home.provision('Continue stranger', stranger.token);
    expect((await read(undefined, stranger.token)).status).toBeGreaterThanOrEqual(400);
    expect((await read(first.nextCursor!, stranger.token, strangerAgent)).status).toBe(400);
    const own = await home.json<Page>(await read(undefined, stranger.token, strangerAgent));
    expect(own.items).toEqual([]);
    expect(own.nextCursor).toBeNull();
    expect((await read(undefined, '')).status).toBeGreaterThanOrEqual(400);
    // A hidden candidate consumes its seek position without truncating the tail.
    const hidden = first.items[0]!.work;
    await home.json(await home.call('PUT', `/v1/me/continue/${hidden.slice(-36)}/hidden`,
      { actingSubject: seeded.reader, hidden: true }, home.reader.token));
    expect((await read(first.nextCursor!)).status).toBe(410);
    const visible: string[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 50; step++) {
      const page = await home.json<Page>(await read(cursor));
      visible.push(...page.items.map(item => item.work));
      if (!page.nextCursor) { cursor = undefined; break; }
      cursor = page.nextCursor;
    }
    expect(cursor).toBeUndefined();
    expect(new Set(visible)).toEqual(new Set([...expected].filter(work => work !== hidden)));
    expect(visible.length).toBe(expected.size - 1);
  } finally { await home.stop(); }
}, 900_000);
