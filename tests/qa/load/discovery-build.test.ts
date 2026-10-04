import { expect, test } from 'bun:test';
import { DATASET, GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshStore, DISCOVERY_REFRESH_COST } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { startMediaStack } from '../integration/media-support.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0362-4000-8000-000000000001`;

test('Discovery build: 10,000 public Works below 60 seconds and one outbox delta within the recovery budget', async () => {
  const stack = await startMediaStack('discovery-load');
  try {
    const epoch = stack.env.lineage.dataEpoch;
    // A native graph workload isolates projection cost from command/fixture
    // creation cost. The integration tier separately checks real relay delivery,
    // ratings, classification, credits, principal isolation and disclosure.
    for (let offset = 0; offset < 10_000; offset += 250) {
      const rows = Array.from({ length: 250 }, (_, i) => {
        const n = (offset + i) * 10;
        return `GRAPH ${iri(GRAPHS.current)} {
          ${iri(id(n))} a schema:CreativeWork, schema:Book ; rv:head ${iri(id(n + 1))} ; rv:mainVersion ${iri(id(n + 2))} .
          ${iri(id(n + 2))} a rv:MainVersion ; rv:work ${iri(id(n))} ; rv:selectionHead ${iri(id(n + 3))} .
          ${iri(id(n + 4))} rv:work ${iri(id(n))} ; rv:publicationHead ${iri(id(n + 5))} .
        } GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(id(n + 1))} a rv:RevisionAnchor ; rv:component ${iri(id(n))} ; rv:dataEpoch ${lit(epoch)} ; rv:sequence 1 .
          ${iri(id(n + 3))} a rv:PublicationSelection ; rv:work ${iri(id(n))} ; rv:mainVersion ${iri(id(n + 2))} ;
            rv:contribution ${iri(id(n + 4))} ; rv:publicationDecision ${iri(id(n + 5))} ; rv:selectedDraft ${iri(id(n + 6))} .
          ${iri(id(n + 5))} a rv:PublicationDecision ; rv:component ${iri(id(n + 4))} ; rv:work ${iri(id(n))} ;
            rv:contribution ${iri(id(n + 4))} ; rv:disclosure rv:Public ; rv:selectedDraft ${iri(id(n + 6))} .
          ${iri(id(n + 6))} a rv:RevisionAnchor ; rv:component ${iri(id(n + 4))} .
        }`;
      }).join('\n');
      await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/> INSERT DATA { ${rows} }`);
    }
    let sequence = '1';
    const position = () => ({ dataEpoch: epoch, sequence });
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 1 } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } }`);
    const projection = new DiscoveryProjection(stack.accessPool), store = new DiscoveryRefreshStore(stack.accessPool);
    const queryTimes: { query: string; ms: number }[] = [];
    const rawQuery = stack.fuseki.query.bind(stack.fuseki);
    stack.fuseki.query = async (query, bytes) => {
      const started = performance.now();
      try { return await rawQuery(query, bytes); }
      finally { queryTimes.push({ query: query.match(/SELECT[^\{]*/)?.[0] ?? '', ms: performance.now() - started }); }
    };
    const registrations: number[] = [];
    const register = projection.register.bind(projection);
    projection.register = async (...args) => {
      const started = performance.now();
      try { return await register(...args); }
      finally { registrations.push(performance.now() - started); }
    };
    const deps = { environment: stack.env, access: stack.access,
      account: { verify: async () => { throw new Error('Anonymous projection'); } },
      relayPosition: { read: async () => position() } };
    const build = async () => {
      const started = performance.now(), before = stack.fuseki.queries;
      let ticks = 0;
      for (;;) {
        const result = await new DiscoveryRefreshWorker(deps, store, projection).tick();
        ticks++;
        expect(result).not.toBe('retry');
        if (result === 'activated') return { ms: performance.now() - started, queries: stack.fuseki.queries - before, ticks };
        if (performance.now() - started > 60_000) throw new Error('Discovery rebuild exceeded 60 seconds');
        await Bun.sleep(DISCOVERY_REFRESH_COST.intervalMs + 1);
      }
    };
    const full = await build();
    console.log('discovery full build', full);
    expect(full.ms).toBeLessThan(60_000);
    const prior = (await stack.accessPool.query('SELECT generation_id FROM access.discovery_generation')).rows[0].generation_id;
    expect((await stack.accessPool.query('SELECT work_count FROM access.discovery_generation WHERE generation_id = $1', [prior])).rows[0].work_count).toBe('10000');
    expect(full.queries).toBeLessThanOrEqual(300);
    sequence = '2';
    queryTimes.length = 0;
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 1 }
        GRAPH ${iri(GRAPHS.current)} { ${iri(id(0))} rv:head ${iri(id(1))} } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 2 }
        GRAPH ${iri(GRAPHS.current)} { ${iri(id(0))} rv:head ${iri(id(7))} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(id(7))} a rv:RevisionAnchor ; rv:component ${iri(id(0))} ;
          rv:predecessor ${iri(id(1))} ; rv:dataEpoch ${lit(epoch)} ; rv:sequence 2 }
        GRAPH ${iri(GRAPHS.outbox)} { <urn:rezics:outbox:discovery-load-2> a rv:OutboxBatch ;
          rv:dataEpoch ${lit(epoch)} ; rv:sequence 2 ; rv:eventCount 1 ; rv:event <urn:rezics:event:discovery-load-2> .
          <urn:rezics:event:discovery-load-2> rv:ordinal 0 ; rv:action "work.edit" ; rv:work ${iri(id(0))} } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 1 } }`);
    const delta = await build();
    console.log('discovery delta', delta, { registrations, queryTimes });
    expect(delta.ms).toBeLessThan(DISCOVERY_REFRESH_COST.recoveryMs);
    const current = (await stack.accessPool.query('SELECT generation_id, changed_works, work_count FROM access.discovery_generation WHERE generation_id <> $1', [prior])).rows[0];
    expect(current.changed_works).toEqual([id(0)]);
    expect(current.work_count).toBe('10000');
    const revised = (await stack.accessPool.query(`SELECT payload->>'revision' AS revision FROM access.discovery_entries($1)
      WHERE generation_id = $1 AND work = $2 AND work_type = '' AND term = ''`, [current.generation_id, id(0)])).rows[0];
    expect(revised.revision).toBe(id(7));
    expect((await stack.accessPool.query(`SELECT payload->>'revision' AS revision FROM access.discovery_entries($1)
      WHERE generation_id = $1 AND work = $2 AND work_type = '' AND term = ''`, [prior, id(0)])).rows[0].revision).toBe(id(1));
    const measured = { works: 10_000, full, delta, intervalMs: DISCOVERY_REFRESH_COST.intervalMs };
    await Bun.write(new URL(`../../../.temp/discovery-load-${Bun.env.REZICS_QA_RUN_ID}.json`, import.meta.url), JSON.stringify(measured));
    console.log(`discovery build measured: ${JSON.stringify(measured)}`);
  } finally { await stack.stop(); }
}, 180_000);
