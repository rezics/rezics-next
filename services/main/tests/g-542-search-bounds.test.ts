import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure, DisclosureStore, type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { queryPublicMainPhrase, queryPublicRealmPhrase, PublicQueryBudgetExceeded } from '../src/modules/work/search-public.ts';
import type { PublicTextPosition } from '../src/modules/work/search-readiness.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
const instance = '11111111-1111-4111-8111-111111111111';
const position = { dataEpoch: 'epoch', sequence: '1', generation: 'urn:rezics:text-index-generation:test',
  population: 512, serverInstanceId: instance, publicSearchWriteEpoch: '0' } as PublicTextPosition;

function fixture(bodyCount: number, fieldCount: number, overlap = true, aliases = false) {
  let restricted = false;
  const row = (n: number) => ({ epoch: term('epoch'), sequence: term('1'),
    indexGeneration: term(position.generation), candidateCount: term(String(bodyCount)),
    work: term(id(n)), main: term(id(n + 1_000)), unit: term(id(n + 2_000)),
    contribution: term(id(n + 3_000)), revision: term(id(n + 4_000)), selection: term(id(n + 5_000)),
    language: term('en'), reason: term('main-fallback'), score: term('1') });
  const graph = new FusekiClient('http://graph.invalid');
  graph.commandHealth = async () => ({ instanceId: instance, moduleVersion: 'test', profiles: {},
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false });
  graph.query = async query => {
    if (query.includes('SELECT ?candidateCount')) {
      return { results: { bindings: Array.from({ length: bodyCount }, (_, i) => row(i + 1)) } };
    }
    if (query.includes('SELECT DISTINCT ?epoch ?sequence ?work')) {
      return { results: { bindings: Array.from({ length: fieldCount }, (_, i) => ({
        ...row(i + 1 + (overlap ? 0 : bodyCount)), ...(aliases ? { field: term('metadata'),
          state: term(JSON.stringify({ kind: 'header', originalTitle: { value: 'needle', language: 'en' },
            localized: [{ language: 'en', title: 'needle', description: null, mainVersionLabel: null,
              tagline: 'needle' }] })) } : { field: term('title'), text: term('needle') }) })) } };
    }
    if (query.includes('SELECT ?work ?head')) {
      const values = /VALUES \?work \{([^}]+)\}/u.exec(query)![1]!;
      const refs = [...values.matchAll(/<https:\/\/rezics\.com\/id\/[0-9a-f-]{36}>/g)]
        .map(match => match[0].slice(1, -1));
      return { results: { bindings: refs.map(work => ({ work: term(work), head: term(id(10_000)),
        ...(query.includes('?owningWork') ? { owningWork: term(work), owningHead: term(id(10_000)) } : {}),
      })) } };
    }
    throw new Error(`Unexpected search read: ${query.slice(0, 100)}`);
  };
  const pool = { query: async (sql: string, args?: unknown[]) => {
    if (sql.includes('jsonb_to_recordset')) {
      expect(sql).toContain('WITH fence AS MATERIALIZED');
      const targets = JSON.parse(String(args![0])) as (DisclosureTarget & { ordinal: number })[];
      expect(targets.length).toBeLessThanOrEqual(64);
      return { rows: targets.map(target => ({ ordinal: target.ordinal, open: true, restricted, assessments: [] })) };
    }
    throw new Error(`Unexpected disclosure read: ${sql.slice(0, 100)}`);
  } } as unknown as Pool;
  const env = { fuseki: graph, objectDirectory: '.temp/g-542', lineage };
  configureDisclosure(env, new DisclosureStore(pool));
  return { env, graph, restrict: (value: boolean) => { restricted = value; } };
}

test('G-542: Main and Realm phrase gates admit 513–1024 combined body/field candidates before mainVersion dedupe', async () => {
  for (const fields of [1, 512]) for (const realm of [false, true]) {
    const run = fixture(512, fields);
    const read = () => searchGraphSnapshot.run({ clients: new Set([run.graph]), lineage, position }, () => realm
      ? queryPublicRealmPhrase(run.env, { phrase: 'needle', language: null, publicFields: {},
        context: { kind: 'realm-local', id: id(20_000) } })
      : queryPublicMainPhrase(run.env, { phrase: 'needle', language: null, publicFields: {} }));
    const visible = await read();
    expect(visible.total).toBe(512);
    expect(visible.results.filter(row => 'matchedField' in row)).toHaveLength(fields);
    run.restrict(true);
    expect((await read()).total).toBe(0);
    run.restrict(false);
    expect((await read()).total).toBe(512);
  }
});

test('G-542: localized field aliases share the bounded disclosure candidate without multiplying counts', async () => {
  const run = fixture(512, 512, true, true);
  const result = await searchGraphSnapshot.run({ clients: new Set([run.graph]), lineage, position }, () =>
    queryPublicMainPhrase(run.env, { phrase: 'needle', language: null, publicFields: {} }));
  expect(result.total).toBe(512);
  expect(result.results.filter(row => 'matchedField' in row && row.matchedField === 'title')).toHaveLength(512);
});

test('G-542: more than 512 distinct final Main Versions retains the typed phrase budget rejection', async () => {
  const run = fixture(1, 512, false);
  await expect(searchGraphSnapshot.run({ clients: new Set([run.graph]), lineage, position }, () =>
    queryPublicMainPhrase(run.env, { phrase: 'needle', language: null, publicFields: {} })))
    .rejects.toBeInstanceOf(PublicQueryBudgetExceeded);
});
