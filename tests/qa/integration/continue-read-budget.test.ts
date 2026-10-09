import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { HOME_READ_BUDGET, meterStatements, seedHome, startHomeStack } from './feed-read-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

test('G407: Continue seeks the next chapter in a 60-chapter Book within its read budget', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['access', 'content', 'relay'], 'owner');
  const original = [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL];
  let home: Awaited<ReturnType<typeof startHomeStack>>;
  try {
    // Pools capture these file-owned databases during startup; restore the
    // process environment before commands or another file can use it.
    [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL] =
      [databases.urls.access, databases.urls.content, databases.urls.relay];
    home = await startHomeStack('continue-long-book', { projectionStart: 'current' });
  } catch (error) { await databases.close(); throw error; }
  finally {
    [Bun.env.ACCESS_DATABASE_URL, Bun.env.CONTENT_DATABASE_URL, Bun.env.ACCOUNT_RELAY_DATABASE_URL] = original;
  }
  try {
    const seeded = await seedHome(home);
    const work = seeded.works[2]!.work;
    const rows = (await home.stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/> SELECT ?structure ?head ?target WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} rv:mainVersion ?main .
        ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureHead ?head ;
          rv:selectedGeneration ?generation .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
          rv:occurrenceRole rv:ChapterRole ; schema:item ?target .
      }
    } LIMIT 3`)).results?.bindings ?? [];
    expect(rows).toHaveLength(2);
    const structure = rows[0]!.structure!.value;
    const target = rows[0]!.target!.value;
    let head = rows[0]!.head!.value;
    const appended: string[] = [];
    for (let first = 3; first <= 60; first += 16) {
      const last = Math.min(60, first + 15);
      const result = await home.json<{ revision: string; occurrences: string[] }>(await home.call('POST',
        `/v1/compositions/${structure.slice(-36)}/changes`, {
          profile: 'book-composition', expectedHead: head, actingSubject: seeded.author,
          operations: Array.from({ length: last - first + 1 }, (_, index) => ({
            op: 'insert', parent: structure, position: 'last', role: 'chapter', target,
            label: { value: `Chapter ${first + index}`, language: 'en' },
          })),
        }, home.author.token), 200);
      head = result.revision;
      appended.push(...result.occurrences);
    }
    expect(appended).toHaveLength(58);
    const completed = appended[28]!; // Chapter 31.
    const next = appended[29]!; // Chapter 32.
    await home.json(await home.call('PUT',
      `/v1/compositions/${structure.slice(-36)}/occurrences/${completed.slice(-36)}/progress`,
      { actingSubject: seeded.reader, expectedVersion: 0, completed: true, position: null },
      home.reader.token, randomUUID()));
    const meter = meterStatements();
    try {
      const path = seeded.signed('/v1/me/continue');
      for (let attempt = 0; attempt < 2; attempt++) {
        const graph = home.stack.fuseki.queries;
        const statements = meter.count();
        const response = await home.call('GET', path, undefined, home.reader.token);
        const body = await response.text();
        expect(response.status).toBe(200);
        const item = (JSON.parse(body) as { items: { work: string;
          nextUnread: { occurrence: string; title: string | null }; unreadCount: { kind: string } }[] })
          .items.find(value => value.work === work);
        expect(item).toMatchObject({ nextUnread: { occurrence: next, title: 'Chapter 32' },
          unreadCount: { kind: 'lower-bound' } });
        expect(home.stack.fuseki.queries - graph).toBeLessThanOrEqual(HOME_READ_BUDGET.continue.graphQueries);
        expect(meter.count() - statements).toBeLessThanOrEqual(HOME_READ_BUDGET.continue.statements);
      }
      expect(meter.violations).toEqual([]);
    } finally { meter.restore(); }
  } finally { try { await home.stop(); } finally { await databases.close(); } }
}, 300_000);
