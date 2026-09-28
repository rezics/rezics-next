import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bestKey } from '../../../services/main/src/modules/feed/ranking.ts';
import { DATASET, GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { budgetFor, HOME_READS, measureRead, meterStatements, seedHome, SIGNED_HOME_READS, startHomeStack }
  from '../integration/feed-read-support.ts';

const WORKS = 10_000, FOLLOWED = 1_000, WARM_RUNS = 5;
/** Native identities: Work n and its six companion resources. */
const id = (n: number, part: number) =>
  `https://rezics.com/id/${n.toString(16).padStart(8, '0')}-0383-4${part.toString(16).padStart(3, '0')}-8000-000000000000`;

test('G383: Home reads stay under 300 ms warm at 10,000 Works and 1,000 follows, within the page budgets', async () => {
  const meter = meterStatements();
  const home = await startHomeStack('home-load');
  try {
    const { stack } = home;
    // Real commands make the mixed page that sits on top: Agents, Realm pick,
    // replies, a list and a book the reader is reading.
    const seeded = await seedHome(home);
    // Native Work publications isolate read cost from command cost, as the
    // discovery load test does. Each has the shape a command-created public
    // Work has for feed, summary and presentation reads, by the seeded author.
    const epoch = stack.env.lineage.dataEpoch;
    const sequence = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } } LIMIT 1`)).results!.bindings[0]!.sequence!.value;
    const started = performance.now();
    for (let offset = 0; offset < WORKS; offset += 250) {
      const rows = Array.from({ length: 250 }, (_, i) => {
        const n = offset + i;
        const [work, main, head, contribution, decision, draft, selection] = [1, 2, 3, 4, 5, 6, 7].map(part => iri(id(n, part)));
        return `GRAPH ${iri(GRAPHS.current)} {
          ${work} a schema:CreativeWork ; rdfs:label ${lit(`Load Work ${n}`)}@en ; rv:head ${head} ; rv:mainVersion ${main} .
          ${main} a rv:MainVersion ; rv:work ${work} ; rv:selectionHead ${selection} .
          ${contribution} a rv:TextContribution ; rv:work ${work} ; rv:author ${iri(seeded.author)} ; rv:publicationHead ${decision} .
        } GRAPH ${iri(GRAPHS.revisions)} {
          ${head} a rv:RevisionAnchor ; rv:component ${work} .
          ${selection} a rv:PublicationSelection ; rv:context ${main} ; rv:work ${work} ; rv:mainVersion ${main} ;
            rv:contribution ${contribution} ; rv:publicationDecision ${decision} ; rv:selectedDraft ${draft} ;
            rv:language "en" ; rv:selectionBasis rv:MainMaintainer ; rv:dataEpoch ${lit(epoch)} ; rv:sequence ${sequence} .
          ${decision} a rv:PublicationDecision ; rv:component ${contribution} ; rv:work ${work} ;
            rv:contribution ${contribution} ; rv:disclosure rv:Public ; rv:selectedDraft ${draft} .
          ${draft} a rv:RevisionAnchor ; rv:component ${contribution} .
        }`;
      }).join('\n');
      await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> INSERT DATA { ${rows} }`);
    }
    // Their projection rows: two months of activity with mixed votes, older
    // than the command-created page, and a reader who follows 1,000 of them.
    const now = Date.now();
    for (let offset = 0; offset < WORKS; offset += 2_000) {
      const range = Array.from({ length: 2_000 }, (_, i) => offset + i);
      const times = range.map(n => new Date(now - 3_600_000 - n * 518_400));
      const scores = range.map(n => n % 13 - 3);
      await stack.accessPool.query(`INSERT INTO access.feed_item (data_epoch, id, sequence, kind, occurred_at,
          time_basis, score, best_key, realm, group_bucket, group_key, group_leader, group_members, sort_time)
        SELECT $1, item.id, $2, 'work', item.at, 'revision', item.score, item.best, NULL, item.id, item.id, true,
          ARRAY[item.id], item.at
        FROM unnest($3::text[], $4::timestamptz[], $5::integer[], $6::double precision[]) AS item(id, at, score, best)`,
      [epoch, sequence, range.map(n => id(n, 7)), times, scores,
        range.map((n, index) => bestKey(scores[index]!, times[index]!.getTime()))]);
    }
    // The seeded Realm and Work follows count toward the 1,000-follow inventory limit.
    const native = FOLLOWED - (await stack.accessPool.query<{ active_count: number }>(
      'SELECT active_count FROM access.follow_inventory WHERE principal_id = $1', [home.reader.principalId])).rows[0]!.active_count;
    await stack.accessPool.query(`INSERT INTO access.follow (principal_id, target, kind, acting_subject, following, revision)
      SELECT $1, target, 'work', $2, true, gen_random_uuid() FROM unnest($3::text[]) AS target`,
    [home.reader.principalId, seeded.reader, Array.from({ length: native }, (_, n) => id(n * 7, 1))]);
    await stack.accessPool.query(`UPDATE access.follow_inventory SET active_count = active_count + $2, revision = $3
      WHERE principal_id = $1`, [home.reader.principalId, native, randomUUID()]);
    const seedMs = performance.now() - started;

    // The slowest graph queries of each read's last run show where time goes.
    const traced: { ms: number; query: string }[] = [];
    const query = stack.fuseki.query.bind(stack.fuseki);
    stack.fuseki.query = async (text, bytes) => {
      const at = performance.now();
      try { return await query(text, bytes); }
      finally { traced.push({ ms: performance.now() - at, query: text.replace(/PREFIX \S+ <[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 160) }); }
    };
    const reads = [
      ...Object.entries(HOME_READS).map(([name, path]) => ({ name: `anonymous ${name}`, path, token: undefined as
        string | undefined, budget: budgetFor(name, false) })),
      ...Object.entries(SIGNED_HOME_READS).map(([name, path]) => ({ name: `signed ${name}`, path: seeded.signed(path),
        token: home.reader.token as string | undefined, budget: budgetFor(name, true) })),
    ];
    const measured = [];
    for (const read of reads) {
      const cold = await measureRead(home, meter, read.path, read.token);
      await measureRead(home, meter, read.path, read.token);
      const runs = [];
      for (let run = 0; run < WARM_RUNS; run++) {
        traced.length = 0;
        runs.push(await measureRead(home, meter, read.path, read.token));
      }
      const slowest = [...traced].sort((a, b) => b.ms - a.ms).slice(0, 3)
        .map(item => `${Math.round(item.ms)}ms ${item.query}`);
      const times = runs.map(run => run.ms).sort((a, b) => a - b);
      measured.push({ ...read, coldMs: Math.round(cold.ms), p50Ms: Math.round(times[Math.floor(WARM_RUNS / 2)]!),
        maxMs: Math.round(times.at(-1)!), graphQueries: Math.max(...runs.map(run => run.graphQueries)),
        statements: Math.max(...runs.map(run => run.statements)), items: runs[0]!.items, slowest });
    }
    const report = { works: WORKS, followed: FOLLOWED, seedMs: Math.round(seedMs), reads: measured.map(
      ({ name, coldMs, p50Ms, maxMs, graphQueries, statements, items, slowest }) =>
        ({ name, coldMs, p50Ms, maxMs, graphQueries, statements, items, slowest })) };
    await Bun.write(new URL(`../../../.temp/home-load-${Bun.env.REZICS_QA_RUN_ID}.json`, import.meta.url),
      JSON.stringify(report, null, 2));
    console.log(`home load measured: ${JSON.stringify(report)}`);

    // The large corpus is read, not skipped: Top reaches native high-score Works.
    const top = await home.json<{ items: { target: { work: string | null } }[] }>(
      await home.call('GET', HOME_READS.topAll));
    expect(top.items.some(item => item.target.work?.includes('-0383-4001-'))).toBe(true);
    for (const read of measured) {
      expect({ read: read.name, p50Under300: read.p50Ms < 300, graphQueries: read.graphQueries <= read.budget.graphQueries,
        statements: read.statements <= read.budget.statements })
        .toEqual({ read: read.name, p50Under300: true, graphQueries: true, statements: true });
    }
    expect(meter.violations).toEqual([]);
  } finally {
    meter.restore();
    await home.stop();
  }
}, 540_000);
