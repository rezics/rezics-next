import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { fixtureCorpus } from '../../../scripts/fixture/corpus.ts';
import { accessOwner } from '../../../scripts/fixture/owners/access.ts';

test('fixture: Access verification counts deterministic fixture IDs, excluding owner-seeded scope gates', async () => {
  const queries: Array<{ sql: string; ids?: string[] }> = [];
  const pool = { query: async (sql: string, values?: unknown[]) => {
    const ids = values?.[0] as string[] | undefined;
    queries.push({ sql, ids });
    // Simulate the migration's additional access:representation-topology row.
    const scoped = sql.includes('= ANY($1::');
    const n = scoped ? ids!.length : 1_001;
    return { rows: [{ n: String(scoped ? n : 0) }] };
  } } as unknown as Pool;
  const corpus = fixtureCorpus('small');

  const counts = await accessOwner.verify(corpus, { pools: { access: pool } } as never);

  expect(counts).toEqual({ 'access.authority_subject': corpus.agents,
    'access.scope_gate': corpus.works, 'access.permission_grant': corpus.works });
  const gateQuery = queries.find(({ sql }) => sql.includes('FROM access.scope_gate'))!;
  expect(gateQuery.sql).toContain('= ANY($1::text[])');
  expect(gateQuery.ids).toHaveLength(corpus.works);
  expect(gateQuery.ids).not.toContain('access:representation-topology');
});
