import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient, SparqlResult } from '../src/infrastructure/fuseki.ts';
import { definitionCreatorAllowed } from '../src/modules/access/definition-creator.ts';
import {
  readReferenceDisclosure,
  REFERENCE_DISCLOSURE_COST,
} from '../src/modules/access/semantic-disclosure.ts';

const native = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = native(1),
  definition = native(2);
const principalId = '00000000-0000-4000-8000-000000000003';
const principal = {
  issuer: 'https://accounts.test',
  subject: 'current-controller',
  emailVerified: false,
};
const admission = '00000000-0000-4000-8000-000000000004';
const receipt = `urn:rezics:receipt:${'a'.repeat(64)}`;
const digest = 'b'.repeat(64);
type Binding = NonNullable<SparqlResult['results']>['bindings'][number];
const receiptBinding = (resource: string): Binding => ({
  resource: { type: 'uri', value: resource },
  admission: { type: 'literal', value: admission },
  receipt: { type: 'uri', value: receipt },
  digest: { type: 'literal', value: digest },
});

/** These fixtures inspect Access's proof contract. PostgreSQL lifecycle and
 * locking behavior is covered separately with real owner tables. */
function reader(options: { bindings?: Binding[]; publicRefs?: string[] } = {}) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const graphs: { query: string; bytes?: number }[] = [];
  const client = {
    release() {},
    async query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values });
      const rows = sql.includes('access.recovery_fence')
        ? [{ open: true, generation: '0' }]
        : sql.startsWith('SELECT id FROM access.principal')
          ? [{ id: principalId }]
          : sql.includes('access.read_platform_permissions')
            ? [
                {
                  id: 'use',
                  action: 'platform:use:platform-admin',
                  scope_id: 'platform:access',
                  generation: '1',
                  witness: 'use',
                },
                {
                  id: 'read',
                  action: 'platform:resource:semantic.read',
                  scope_id: 'semantic:read:*',
                  generation: '1',
                  witness: 'read',
                },
              ]
            : sql.includes('SELECT $3::text AS receipt')
              ? [{}]
              : sql.includes('jsonb_to_recordset') &&
                  sql.includes("a.scope_id = 'semantic:create:root'")
                ? (JSON.parse(values[0] as string) as { resource: string }[])
                : sql.startsWith('SELECT a.id FROM access.admission')
                  ? [{ id: admission }]
                  : sql.includes('FROM unnest($1::text[]) AS wanted(resource)')
                    ? (values[0] as string[]).map((resource) => ({ resource }))
                    : [];
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  const graph: Pick<FusekiClient, 'query'> = {
    async query(query, bytes) {
      graphs.push({ query, bytes });
      if (query.includes('rv:admittedScope "semantic:create:root"')) {
        const requested = [...query.matchAll(/BIND\(<([^>]+)> AS \?resource\)/g)].map(
          (match) => match[1]!,
        );
        return {
          results: {
            bindings:
              options.bindings ??
              (requested.length ? requested.map(receiptBinding) : [receiptBinding(definition)]),
          },
        };
      }
      return {
        results: {
          bindings: query.includes('rv:semanticHead')
            ? (options.publicRefs ?? []).map((resource) => ({
                resource: { type: 'uri', value: resource },
              }))
            : [],
        },
      };
    },
  };
  return {
    client,
    graph,
    statements,
    graphs,
    pool: { connect: async () => client } as unknown as Pool,
  };
}

const definitionQueries = (r: ReturnType<typeof reader>) =>
  r.graphs.filter((row) => row.query.includes('rv:admittedScope "semantic:create:root"'));
const definitionStatements = (r: ReturnType<typeof reader>) =>
  r.statements.filter(
    (row) =>
      row.sql.includes('access.admission a') &&
      row.sql.includes("a.scope_id = 'semantic:create:root'"),
  );
const normalize = (query: string) => query.replace(/\s+/g, ' ').trim();

test('definition singleton and reference batch retain the same exact creation and current-head graph proof', async () => {
  const r = reader();
  expect(await definitionCreatorAllowed(r.client, r.graph, principalId, actor, definition)).toBe(
    true,
  );
  expect(await readReferenceDisclosure(r, principal, actor, [definition])).toEqual(
    new Set([definition]),
  );
  const [scalar, batch] = definitionQueries(r);
  expect(scalar!.bytes).toBe(4096);
  expect(batch!.bytes).toBe(8192);
  const scalarPattern = scalar!.query
    .split('WHERE {')[1]!
    .replace(/\s*} LIMIT 2\s*$/, '')
    .trim();
  const batchPattern = batch!.query
    .split(`BIND(<${definition}> AS ?resource)`)[1]!
    .replace(/\s*} LIMIT 2 }\s*}\s*$/, '')
    .trim();
  expect(normalize(batchPattern)).toBe(normalize(scalarPattern));
  for (const constraint of [
    'rv:lifecycle rv:Active',
    'rv:protectionHead ?protection',
    '?head a rv:ErasedRevision',
    'rv:revision ?first',
    '?first a rv:DefinitionRevision',
    '?first rv:predecessor ?predecessor',
    '?receipt rv:expectedHead ?expected',
    'rv:outcome rv:Succeeded',
  ])
    expect(batchPattern).toContain(constraint);
});

test('definition receipt provenance stays bound to its creator Agent while authority uses the current principal controller', async () => {
  const r = reader();
  await definitionCreatorAllowed(r.client, r.graph, principalId, actor, definition);
  await readReferenceDisclosure(r, principal, actor, [definition]);
  const [scalar, batch] = definitionStatements(r);
  for (const statement of [scalar!, batch!]) {
    const sql = normalize(statement.sql);
    expect(sql).not.toContain('a.principal_id =');
    expect(sql).toContain('a.acting_subject = $3');
    expect(sql).toContain('r.principal_id = $2');
    expect(sql).toContain('r.subject_id = a.acting_subject');
    expect(sql).toContain('p.id = r.principal_id AND p.active');
    expect(sql).toContain("s.kind = 'agent'");
    expect(sql).toContain('s.active');
    expect(sql).toContain(
      "r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()",
    );
    expect(sql).toContain("a.action = 'semantic.change'");
    expect(sql).toContain("a.state = 'sealed' AND a.graph_outcome = 'succeeded'");
    expect(sql).toContain('a.graph_receipt =');
    expect(sql).toContain('a.request_digest =');
  }
  expect(normalize(batch!.sql)).toContain('JOIN LATERAL');
  expect(normalize(batch!.sql)).toContain('ORDER BY r.id LIMIT 1 FOR SHARE OF r, p, s');
  expect(batch!.sql).toContain('FOR SHARE OF a');
  expect(batch!.values).toEqual([
    JSON.stringify([{ resource: definition, admission, receipt, digest }]),
    principalId,
    actor,
  ]);
});

for (const invalid of [
  { name: 'missing admission', binding: { admission: undefined } },
  {
    name: 'malformed admission',
    binding: { admission: { type: 'literal', value: '-'.repeat(36) } },
  },
  {
    name: 'invalid receipt',
    binding: { receipt: { type: 'uri', value: 'urn:rezics:receipt:short' } },
  },
  { name: 'invalid digest', binding: { digest: { type: 'literal', value: 'C'.repeat(64) } } },
]) {
  test(`definition singleton and batch reject ${invalid.name} before admission lookup`, async () => {
    const row = { ...receiptBinding(definition), ...invalid.binding } as unknown as Binding;
    const r = reader({ bindings: [row] });
    expect(await definitionCreatorAllowed(r.client, r.graph, principalId, actor, definition)).toBe(
      false,
    );
    expect(await readReferenceDisclosure(r, principal, actor, [definition])).toEqual(new Set());
    expect(definitionStatements(r)).toEqual([]);
  });
}

test('duplicate receipt rows deny only the damaged definition rather than truncating its peer', async () => {
  const peer = native(5),
    duplicate = receiptBinding(definition);
  const r = reader({ bindings: [duplicate, duplicate, receiptBinding(peer)] });
  expect(await definitionCreatorAllowed(r.client, r.graph, principalId, actor, definition)).toBe(
    false,
  );
  expect(await readReferenceDisclosure(r, principal, actor, [definition, peer])).toEqual(
    new Set([peer]),
  );
  expect(JSON.parse(definitionStatements(r)[0]!.values[0] as string)).toEqual([
    { resource: peer, admission, receipt, digest },
  ]);
});

test('65 private definition references retain one batch lookup and a two-row graph ambiguity probe per target', async () => {
  const refs = Array.from({ length: 65 }, (_, index) => native(index + 10));
  const r = reader();
  expect(await readReferenceDisclosure(r, principal, actor, refs)).toEqual(new Set(refs));
  expect(definitionStatements(r)).toHaveLength(1);
  const [batch] = definitionQueries(r);
  expect(batch!.query.match(/LIMIT 2/g)).toHaveLength(65);
  expect(batch!.query.match(/BIND\(/g)).toHaveLength(65);
  expect(batch!.bytes).toBe(66 * REFERENCE_DISCLOSURE_COST.receiptBytesPerResource);
  expect(r.graphs.length).toBeLessThanOrEqual(REFERENCE_DISCLOSURE_COST.graphReads);
  expect(JSON.parse(definitionStatements(r)[0]!.values[0] as string)).toHaveLength(65);
  const oversized = reader();
  await expect(
    readReferenceDisclosure(oversized, principal, actor, [...refs, native(100)]),
  ).rejects.toThrow('semantic disclosure batch exceeds its profile');
  expect(oversized.statements).toEqual([]);
  expect(oversized.graphs).toEqual([]);
});

test('an unexpected receipt target rejects the batch and rolls back its authority transaction', async () => {
  const r = reader({ bindings: [receiptBinding(native(99))] });
  await expect(readReferenceDisclosure(r, principal, actor, [definition])).rejects.toThrow(
    'reference receipt batch is incomplete',
  );
  expect(r.statements.at(-1)!.sql).toBe('ROLLBACK');
  expect(definitionStatements(r)).toEqual([]);
});

test('public relation vocabulary disclosure remains independent of creation identity', async () => {
  const r = reader({ publicRefs: [definition] });
  expect(await readReferenceDisclosure(r, null, null, [definition])).toEqual(new Set([definition]));
  expect(definitionQueries(r)).toEqual([]);
  expect(definitionStatements(r)).toEqual([]);
  expect(r.graphs).toHaveLength(1);
  const publicQuery = r.graphs[0]!.query;
  expect(publicQuery).toContain('rv:definitionKind rv:RelationDefinition');
  expect(publicQuery).toContain('<https://rezics.com/vocab/semanticWork>');
  expect(publicQuery).toContain('rv:lifecycle rv:Active');
  expect(publicQuery).toContain('rv:protectionHead ?protection');
  expect(publicQuery).not.toContain('rv:admissionId');
});
