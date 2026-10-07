import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { authorWorkGeneration, authorWorkGenerations } from '../src/modules/access/author-baseline.ts';
import { GRAPHS } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1), work = id(2), main = id(3), parent = id(4);
const candidate = (action: string) => ({ resource: work, generation: '7', main_version: main, action,
  scope_id: action === 'work.create' ? 'work:create:root' : `work:edit:${parent}`,
  creation_admission: '00000000-0000-4000-8000-000000000005',
  graph_receipt: 'urn:rezics:receipt:creation', request_digest: 'a'.repeat(64) });

for (const action of ['work.create', 'work.edit']) {
  test(`${action} batch evaluates the same sealed receipt and unerased current-head pattern as singleton`, async () => {
    const proof = candidate(action), queries: string[] = [];
    const client = { query: async () => ({ rows: [proof] }) } as unknown as PoolClient;
    const graph: Pick<FusekiClient, 'query'> = { async query(query) {
      queries.push(query);
      return query.includes(' ASK ')
        ? { boolean: true }
        : { results: { bindings: [{ resource: { type: 'uri', value: work } }] } };
    } };
    expect(await authorWorkGeneration(client, graph, 'principal', actor, work)).toBe('7');
    expect(await authorWorkGenerations(client, graph, 'principal', actor, [work])).toEqual(new Map([[work, '7']]));
    const singleton = queries[0]!.split(' ASK {')[1]!.trim().replace(/\}\s*$/, '').trim();
    const batch = queries[1]!.split('FILTER EXISTS {')[1]!.split('} }\n    } LIMIT')[0]!.trim();
    const normalized = (query: string) => query.replaceAll(`<${work}>`, '?resource').replace(/\s+/g, ' ').trim();
    expect(normalized(batch)).toBe(normalized(singleton));
    for (const query of queries) {
      expect(query).toContain('a rv:Post ; rv:head ?head');
      expect(query).toContain(`GRAPH <${GRAPHS.receipts}>`);
      expect(query).toContain(`<${proof.graph_receipt}>`);
      expect(query).toContain(`rv:admissionId "${proof.creation_admission}"`);
      expect(query).toContain(`rv:requestDigest "${proof.request_digest}"`);
      expect(query).toContain(`rv:admittedScope "${proof.scope_id}"`);
      expect(query).toContain('rv:outcome rv:Succeeded');
      expect(query).toContain('?erasedPublication rv:contentRevision ?erasedRevision');
      expect(query).toContain('?erasedRevision a rv:ErasedRevision');
      expect(query).toContain('?erasedWorkHead a rv:ErasedRevision');
      expect(query).toContain('rv:protectionHead ?protection');
      if (action === 'work.create') {
        expect(query).toContain(`rv:mainVersion <${main}>`);
        expect(query).toContain('a schema:CreativeWork ; rv:head ?head');
        expect(query).toContain('rv:work');
      } else {
        expect(query).toContain('(rv:post|rv:chapterWork)');
        expect(query).not.toContain('a schema:CreativeWork');
      }
    }
    expect(queries[1]).toContain('SELECT DISTINCT ?resource');
    expect(queries[1]).toContain('LIMIT 2');
  });
}

test('failed receipt/current-head proofs yield no generations for either evaluator shape', async () => {
  const client = { query: async () => ({ rows: [candidate('work.create')] }) } as unknown as PoolClient;
  const graph: Pick<FusekiClient, 'query'> = { query: async () => ({ boolean: false, results: { bindings: [] } }) };
  expect(await authorWorkGeneration(client, graph, 'principal', actor, work)).toBeNull();
  expect(await authorWorkGenerations(client, graph, 'principal', actor, [work])).toEqual(new Map());
});

test('author batch rejects over-bound and invalid inputs before either owner query', async () => {
  const client = { query: async () => { throw new Error('unexpected candidate query'); } } as unknown as PoolClient;
  const graph: Pick<FusekiClient, 'query'> = { query: async () => { throw new Error('unexpected graph query'); } };
  for (const targets of [[], Array(66).fill(work), ['urn:foreign']]) {
    expect(await authorWorkGenerations(client, graph, 'principal', actor, targets)).toEqual(new Map());
  }
  expect(await authorWorkGenerations(client, graph, 'principal', 'urn:foreign', [work])).toEqual(new Map());
  expect(await authorWorkGenerations(client, undefined, 'principal', actor, [work])).toEqual(new Map());
});

test('candidate ambiguity cannot enlarge the requested authority set or reach graph proof', async () => {
  const graph: Pick<FusekiClient, 'query'> = { query: async () => { throw new Error('unexpected graph query'); } };
  for (const rows of [[candidate('work.create'), candidate('work.create')], [{ ...candidate('work.create'), resource: id(9) }]]) {
    const client = { query: async () => ({ rows }) } as unknown as PoolClient;
    await expect(authorWorkGenerations(client, graph, 'principal', actor, [work])).rejects.toThrow('candidate batch is ambiguous');
  }
});
