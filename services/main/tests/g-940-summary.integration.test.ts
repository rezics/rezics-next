import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import {
  DisclosureStore,
  configureDisclosure,
  discloseInventory,
} from '../src/modules/disclosure/read.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { migrateTracked } from '../../../scripts/ops/migrate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test('G-940: a collection summary stays constant in cost at 19 and 1000 chapter occurrences', async () => {
  if (!process.env.FUSEKI_URL || !process.env.ACCESS_DATABASE_URL)
    throw new Error('Run through the QA integration tier');
  const graph = new FusekiClient(process.env.FUSEKI_URL);
  const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
  const env: WorkActivationEnvironment = {
    fuseki: graph,
    objectDirectory: '.temp/g-940',
    lineage: {
      dataEpoch: process.env.MAIN_DATA_EPOCH!,
      routingEpoch: process.env.MAIN_ROUTING_EPOCH!,
    },
  };
  configureDisclosure(env, new DisclosureStore(pool));
  const collection = id(),
    work = id(),
    head = id(),
    main = id(),
    structure = id(),
    generation = id();
  const occurrences = Array.from({ length: 1000 }, () => ({ occurrence: id(), placement: id() }));
  try {
    await graph.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(collection)} a rv:Collection ; rv:collectionState rv:Active ; rv:disclosure rv:Public ; schema:name "Cost collection"@en .
        ${iri(work)} a schema:CreativeWork ; rv:head ${iri(head)} .
        ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} .
        ${iri(structure)} rv:structureOf ${iri(main)} ; rv:selectedGeneration ${iri(generation)} .
      } }`);
    const insert = async (start: number, end: number) => {
      await graph.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${occurrences
          .slice(start, end)
          .map(
            ({ occurrence, placement }) => `
          ${iri(occurrence)} a schema:ListItem ; rv:structure ${iri(structure)} .
          ${iri(placement)} a rv:OccurrencePlacement ; rv:generation ${iri(generation)} ; rv:occurrence ${iri(occurrence)} .`,
          )
          .join('\n')} } }`);
    };
    let graphQueries = 0;
    const query = graph.query.bind(graph);
    graph.query = async (...args) => {
      graphQueries++;
      return query(...args);
    };
    const measure = async () => {
      const times: number[] = [];
      // Warm the same public summary path before taking the median of five reads.
      for (let sample = 0; sample < 6; sample++) {
        const before = graphQueries,
          started = performance.now();
        const result = await readResourceSummaries(
          env,
          undefined,
          {},
          {
            resources: [collection],
            context: DEFAULT_MEDIA_CONTEXT,
            language: 'en',
            includeCollections: true,
          },
        );
        const elapsed = performance.now() - started;
        expect(result.summaries).toMatchObject([
          { reference: collection, status: 'available', type: 'collection' },
        ]);
        expect(graphQueries - before).toBe(3);
        if (sample) times.push(elapsed);
      }
      return times.sort((a, b) => a - b)[2]!;
    };
    await insert(0, 19);
    const small = await measure();
    await insert(19, 1000);
    const large = await measure();
    console.log(
      `G-940 collection summary median: 19 chapters=${small.toFixed(1)}ms; 1000 chapters=${large.toFixed(1)}ms`,
    );
    const evidenceDirectory = resolve(import.meta.dir, '../../../.temp');
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(
      join(evidenceDirectory, `g-940-summary-cost-${process.env.REZICS_QA_RUN_ID}.json`),
      JSON.stringify({ chapters: [19, 1000], medianMs: [small, large], graphQueriesPerSummary: 3 }),
    );
    // Timing complements query-count checks: a fixed number of queries can still scan the entire inventory.
    expect(large).toBeLessThan(small * 3 + 150);
    expect(large).toBeLessThan(750);

    // Scoped OPTIONALs must still infer an occurrence's owner and preserve absent/non-Work targets.
    const captured: unknown[] = [];
    configureDisclosure(env, {
      read: async (targets) => {
        captured.push(...targets);
        return targets.map(() => 'visible');
      },
    });
    const missing = id();
    expect(
      await discloseInventory(
        env,
        [collection, occurrences[999]!.occurrence, missing].map((resource) => ({
          owner: 'graph',
          resource,
          component: 'name',
        })),
        ANONYMOUS_VIEWER,
        'summary',
      ),
    ).toEqual(['visible', 'visible', 'visible']);
    expect(captured).toMatchObject([
      { resource: collection },
      { resource: occurrences[999]!.occurrence, work, workRevision: head },
      { resource: missing },
    ]);
    expect(captured[0]).not.toHaveProperty('work');
    expect(captured[2]).not.toHaveProperty('work');
  } finally {
    configureDisclosure(env, null);
    await pool.end();
  }
}, 60_000);

test('G-940: tracked migrations apply 1000 after 999 in PostgreSQL and replay without writes', async () => {
  if (!process.env.ACCESS_DATABASE_URL) throw new Error('Run through the QA integration tier');
  const root = resolve(import.meta.dir, '../../..');
  mkdirSync(join(root, '.temp'), { recursive: true });
  const fixture = mkdtempSync(join(root, '.temp/g-940-tracked-'));
  const directory = 'services/main/migrations/access';
  const schema = `g940_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
  const files = ['998_create.sql', '999_previous.sql', '1000_next.sql'];
  try {
    mkdirSync(join(fixture, directory), { recursive: true });
    writeFileSync(
      join(fixture, directory, files[0]!),
      `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.applied (version integer);`,
    );
    writeFileSync(
      join(fixture, directory, files[1]!),
      `INSERT INTO ${schema}.applied VALUES (999);`,
    );
    writeFileSync(
      join(fixture, directory, files[2]!),
      `INSERT INTO ${schema}.applied VALUES (1000);`,
    );
    expect(await migrateTracked(process.env.ACCESS_DATABASE_URL, fixture, directory)).toEqual(
      files.map((file) => `${directory}/${file}`),
    );
    expect(
      (await pool.query(`SELECT version FROM ${schema}.applied`)).rows.map((row) => row.version),
    ).toEqual([999, 1000]);
    expect(await migrateTracked(process.env.ACCESS_DATABASE_URL, fixture, directory)).toEqual([]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query('DELETE FROM public.rezics_local_migration WHERE name = ANY($1::text[])', [
      files.map((file) => `${directory}/${file}`),
    ]);
    await pool.end();
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
