import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { authorWorkGeneration } from '../src/modules/access/author-baseline.ts';
import { readReferenceDisclosure } from '../src/modules/access/semantic-disclosure.ts';

const native = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = native(1), work = native(2), main = native(3), parent = native(4);
const principal = { issuer: 'https://accounts.test', subject: 'successor', emailVerified: true };
const principalId = '00000000-0000-4000-8000-000000000005';

for (const action of ['work.create', 'work.edit']) {
  test(`reference ${action} proof preserves the scalar current-head, receipt and erasure contract`, async () => {
    const proof = { resource: work, generation: '2', main_version: main, action,
      scope_id: action === 'work.create' ? 'work:create:root' : `work:edit:${parent}`,
      creation_admission: '00000000-0000-4000-8000-000000000006',
      graph_receipt: `urn:rezics:receipt:${'a'.repeat(64)}`, request_digest: 'b'.repeat(64) };
    const queries: { sql: string; values: unknown[] }[] = [];
    const client = { release() {}, async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values });
      const rows = sql.includes('access.recovery_fence') ? [{ open: true, generation: '0' }]
        : sql.startsWith('SELECT id FROM access.principal') ? [{ id: principalId }]
        : sql.includes('FROM access.agent_provision a') ? [{}]
        : sql.includes('work_maintainer_set') ? [proof] : [];
      return { rows, rowCount: rows.length };
    } } as unknown as PoolClient;
    const graphQueries: { query: string; bytes?: number }[] = [];
    const graph: Pick<FusekiClient, 'query'> = { async query(query, bytes) {
      graphQueries.push({ query, bytes });
      if (query.includes(' ASK ')) return { boolean: true };
      return { results: { bindings: query.includes(proof.graph_receipt)
        ? [{ resource: { type: 'uri', value: work } }] : [] } };
    } };
    const pool = { connect: async () => client } as unknown as Pool;
    expect(await readReferenceDisclosure({ pool, graph }, principal, actor, [work])).toEqual(new Set([work]));
    const candidates = queries.filter(row => row.sql.includes('work_maintainer_set'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.values).toEqual([[work], principalId, actor]);
    expect(candidates[0]!.sql).toContain('FOR SHARE OF s, m, r, p, agent');
    expect(candidates[0]!.sql).not.toContain('a.principal_id =');
    expect(candidates[0]!.sql).not.toContain('a.acting_subject =');
    const batch = graphQueries.find(row => row.query.includes(proof.graph_receipt))!;
    expect(batch.bytes).toBe(16_384);
    expect(batch.query).toContain('SELECT DISTINCT ?resource');
    expect(batch.query).toContain('LIMIT 2');
    expect(await authorWorkGeneration(client, graph, principalId, actor, work)).toBe('2');
    const scalar = graphQueries.at(-1)!.query.split(' ASK {')[1]!.trim().replace(/\}\s*$/, '').trim();
    const pattern = batch.query.split('FILTER EXISTS {')[1]!.split('} }\n    } LIMIT')[0]!.trim();
    const normalize = (query: string) => query.replaceAll(`<${work}>`, '?resource').replace(/\s+/g, ' ').trim();
    expect(normalize(pattern)).toBe(normalize(scalar));
    expect(batch.query).toContain('?erasedWorkHead a rv:ErasedRevision');
    expect(batch.query).toContain('?erasedPublication rv:contentRevision ?erasedRevision');
    expect(batch.query).toContain('rv:protectionHead ?protection');
    expect(batch.query).toContain(`rv:admissionId "${proof.creation_admission}"`);
    expect(batch.query).toContain(`rv:requestDigest "${proof.request_digest}"`);
    expect(batch.query).toContain(`rv:admittedScope "${proof.scope_id}"`);
    expect(batch.query).toContain('rv:outcome rv:Succeeded');
    if (action === 'work.create') expect(batch.query).toContain(`rv:mainVersion <${main}>`);
    else expect(batch.query).toContain('(rv:post|rv:chapterWork)');
  });
}
