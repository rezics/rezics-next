import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { authorWorkGeneration } from '../src/modules/access/author-baseline.ts';
import { baselineTargetAllowed } from '../src/modules/access/baseline.ts';

const post = 'https://rezics.com/id/10000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/10000000-0000-4000-8000-000000000002';
const book = 'https://rezics.com/id/10000000-0000-4000-8000-000000000003';

test('Post custody uses its own sealed creation and live maintainer generation', async () => {
  const queries: string[] = [];
  const client = { query: (sql: string, values: unknown[]) => {
    expect(values).toEqual([post, 'principal', actor]);
    expect(sql).toContain('m.work = s.work');
    expect(sql).toContain('FOR SHARE OF s');
    return { rows: [{ generation: '7', main_version: post, action: 'work.edit', scope_id: `work:edit:${book}`,
      creation_admission: 'admission', graph_receipt: 'urn:rezics:receipt:chapter', request_digest: 'digest' }] };
  } } as unknown as PoolClient;
  const graph = { query: (query: string) => { queries.push(query); return { boolean: true }; } } as unknown as FusekiClient;
  expect(await authorWorkGeneration(client, graph, 'principal', actor, post)).toBe('7');
  expect(queries[0]).toContain('a rv:Post');
  expect(queries[0]).toContain('(rv:post|rv:chapterWork)');
  expect(queries[0]).not.toContain('schema:isPartOf');
});

test('Public Post comments require the exact publicly eligible revision', async () => {
  const queries: string[] = [];
  const graph = { query: (query: string) => { queries.push(query); return { boolean: true }; } } as unknown as FusekiClient;
  expect(await baselineTargetAllowed({} as PoolClient, graph, 'principal', actor,
    { kind: 'comment', id: post }, false, null, '10000000-0000-4000-8000-000000000004')).toBe(true);
  expect(queries[0]).toContain('a rv:Post');
  expect(queries[0]).toContain('rv:contentRevision <urn:rezics:content:revision:10000000-0000-4000-8000-000000000004>');
  expect(queries[0]).toContain('rv:disclosure rv:Public');
  expect(await baselineTargetAllowed({} as PoolClient, graph, 'principal', actor,
    { kind: 'comment', id: post }, false)).toBe(false);
});
