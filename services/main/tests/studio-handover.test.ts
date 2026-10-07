import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { authorWorkGeneration, authorWorkGenerations } from '../src/modules/access/author-baseline.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1), work = id(2), main = id(3), other = id(4), otherActor = id(5);

test('mixed Studio acting subjects retain the singleton exact receipt and current-head evaluator in one batch', async () => {
  for (const action of ['work.create', 'work.edit']) {
    const candidate = { resource: work, generation: '2', main_version: main, action,
      scope_id: action === 'work.create' ? 'work:create:root' : `work:edit:${other}`,
      creation_admission: '00000000-0000-4000-8000-000000000006',
      graph_receipt: 'urn:rezics:receipt:fixture', request_digest: 'a'.repeat(64) };
    const sql: { query: string; params: unknown[] }[] = [], graphQueries: string[] = [];
    const client = { query: async (query: string, params: unknown[]) => {
      sql.push({ query, params }); return { rows: [candidate] };
    } } as unknown as PoolClient;
    const graph: Pick<FusekiClient, 'query'> = { async query(query) {
      graphQueries.push(query);
      return query.includes('ASK {') ? { boolean: true }
        : { results: { bindings: [{ resource: { type: 'uri', value: work } }] } };
    } };
    expect(await authorWorkGeneration(client, graph, 'principal', actor, work)).toBe('2');
    expect(await authorWorkGenerations(client, graph, 'principal',
      new Map([[work, actor], [other, otherActor]]), [other, work, work])).toEqual(new Map([[work, '2']]));
    expect(sql[1]!.params).toEqual([[work, other].sort(), 'principal', [actor, otherActor]]);
    expect(sql[1]!.query).toContain('unnest($1::text[], $3::text[]) AS wanted(work, actor)');
    expect(sql[1]!.query).toContain('m.agent = wanted.actor');
    expect(sql[1]!.query).toContain('FOR SHARE OF s, m, r, p, agent');
    const scalar = graphQueries[0]!.split('ASK {')[1]!.trim().replace(/\}\s*$/, '').trim();
    const batch = graphQueries[1]!.split('FILTER EXISTS {')[1]!.split('} }\n    } LIMIT')[0]!.trim();
    const normalize = (query: string) => query.replaceAll(`<${work}>`, '?resource').replace(/\s+/g, ' ').trim();
    expect(normalize(batch)).toBe(normalize(scalar));
    expect(graphQueries).toHaveLength(2);
  }
});

test('invalid or absent per-Work acting subjects and oversized chapter proof batches never query either owner', async () => {
  const client = { query: async () => { throw new Error('unexpected SQL'); } } as unknown as PoolClient;
  const graph: Pick<FusekiClient, 'query'> = { query: async () => { throw new Error('unexpected graph'); } };
  for (const subjects of [new Map<string, string>(), new Map([[work, 'urn:invalid']])]) {
    expect(await authorWorkGenerations(client, graph, 'principal', subjects, [work])).toEqual(new Map());
  }
  expect(await authorWorkGenerations(client, graph, 'principal', new Map([[work, actor]]), Array(66).fill(work))).toEqual(new Map());
});
