import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { readShelfMetadata } from '../src/modules/library/backfill.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const other = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';

test('a shelf metadata read does not start another metadata graph read', async () => {
  let graphCalls = 0;
  const access = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const content = { query: async () => ({ rows: [{}] }) } as unknown as Pool;
  const graph = { query: async () => {
    graphCalls += 1;
    const nested = await readShelfMetadata(content, access, graph, agent, other);
    expect(nested).toEqual({ titleKey: null, ownRating: null, lastReadAt: null });
    return { results: { bindings: [{ label: { value: 'Kept', 'xml:lang': 'en' }, main: { value: work } }] } };
  } } as unknown as FusekiClient;
  const metadata = await readShelfMetadata(content, access, graph, agent, work);
  expect(graphCalls).toBe(1);
  expect(metadata.titleKey).toBe('kept');
  expect(metadata.ownRating).toBeNull();
});
