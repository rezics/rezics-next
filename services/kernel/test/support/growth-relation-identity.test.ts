import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { assertGrowthAccessPaths, type AccessPathSample } from './growth-access-path.ts';
import { costOf, type Capture, type Cost } from './growth-cost.ts';
import {
  keyedRelationEntries,
  RELATION_CATALOG_LOOKUP_CHUNK_SIZE,
  relationCatalogLookupRequests,
  type RelationIdentity,
} from './growth-relation-identity.ts';
import { statementAttributions } from './growth-report.ts';

const relations: readonly RelationIdentity[] = [
  { database: 'kernel', schema: 'content', kind: 'relation', name: 'report' },
  { database: 'auth', schema: 'content', kind: 'relation', name: 'report' },
  { database: 'kernel', schema: 'archive', kind: 'relation', name: 'report' },
];

function bitmapPlan(schema: string) {
  return {
    'Node Type': 'Bitmap Heap Scan',
    Schema: schema,
    'Relation Name': 'report',
    'Actual Rows': 1,
    'Actual Loops': 1,
    'Shared Hit Blocks': 4,
    'Shared Read Blocks': 0,
    Plans: [
      {
        'Node Type': 'Bitmap Index Scan',
        'Index Name': 'report_idx',
        'Actual Rows': 1,
        'Actual Loops': 1,
        'Shared Hit Blocks': 1,
        'Shared Read Blocks': 0,
      },
    ],
  };
}

test('relation and index costs retain database and schema provenance', () => {
  const query = 'SELECT * FROM content.report';
  const capture: Capture = {
    statements: [query, query, query],
    plans: [
      [{ 'Query Text': query, Plan: bitmapPlan('content') }],
      [{ 'Query Text': query, Plan: bitmapPlan('content') }],
      [{ 'Query Text': query, Plan: bitmapPlan('archive') }],
    ],
    planDatabases: ['kernel', 'auth', 'kernel'],
  };
  const cost = costOf(capture);
  const tableIdentities = Object.values(cost.relations)
    .map(({ identity }) => identity)
    .filter((identity): identity is RelationIdentity => identity?.kind === 'relation');
  const indexIdentities = Object.values(cost.relations)
    .map(({ identity }) => identity)
    .filter((identity): identity is RelationIdentity => identity?.kind === 'index');

  assert.deepEqual(tableIdentities.map(({ database, schema, name }) => [database, schema, name]).sort(), [
    ['auth', 'content', 'report'],
    ['kernel', 'archive', 'report'],
    ['kernel', 'content', 'report'],
  ]);
  assert.deepEqual(indexIdentities.map(({ database, schema, name }) => [database, schema, name]).sort(), [
    ['auth', 'content', 'report_idx'],
    ['kernel', 'archive', 'report_idx'],
    ['kernel', 'content', 'report_idx'],
  ]);
  assert.equal(statementAttributions(capture)[0]?.relationIdentities?.length, 6);
});

test('relation catalog lookups request only distinct measured identities in bounded chunks', () => {
  const requested: readonly RelationIdentity[] = [
    { database: 'kernel', schema: 'content', kind: 'relation', name: 'report' },
    { database: 'auth', schema: 'content', kind: 'relation', name: 'report' },
    { database: 'kernel', schema: 'archive', kind: 'relation', name: 'report' },
    { database: 'kernel', schema: 'content', kind: 'index', name: 'report_idx' },
  ];
  const [lookup] = relationCatalogLookupRequests([...requested, requested[0]!]);
  assert.match(lookup!.text, /unnest\(\$1::text\[\], \$2::text\[\], \$3::text\[\], \$4::text\[\]\)/);
  assert.match(lookup!.text, /wanted\.database IS NULL OR wanted\.database = current_database\(\)/);
  assert.match(lookup!.text, /wanted\.schema IS NULL OR wanted\.schema = n\.nspname/);
  assert.match(lookup!.text, /wanted\.kind = 'index'.*wanted\.kind = 'relation'/s);
  assert.deepEqual(lookup!.values, [
    ['kernel', 'auth', 'kernel', 'kernel'],
    ['content', 'content', 'archive', 'content'],
    ['relation', 'relation', 'relation', 'index'],
    ['report', 'report', 'report', 'report_idx'],
  ]);

  const large = Array.from({ length: RELATION_CATALOG_LOOKUP_CHUNK_SIZE * 2 + 1 }, (_, index) => ({
    database: 'kernel',
    schema: 'content',
    kind: 'relation' as const,
    name: `table_${index}`,
  }));
  const chunks = relationCatalogLookupRequests([...large, large[0]!]);
  assert.deepEqual(chunks.map(({ values }) => values[3].length), [128, 128, 1]);
});

test('access-path checks select the matching database and schema footprint', () => {
  const pages = [2, 12, 10];
  const sizes = keyedRelationEntries(
    relations.map((identity, index) => ({
      identity,
      value: { identity, reltuples: 1, relpages: pages[index]! },
    })),
  );
  const relationCosts = keyedRelationEntries(
    relations.map((identity) => ({
      identity,
      value: { identity, rows: 1, blocks: 1, nodes: 1, sequentialScans: 1 },
    })),
  );
  const cost: Cost = {
    statements: 1,
    controlStatements: 0,
    catalogStatements: 0,
    plans: 1,
    rows: 1,
    blocks: 1,
    sharedHit: 1,
    sharedRead: 0,
    relations: relationCosts,
  };
  const sample: AccessPathSample = { scale: 1, repetitions: [cost], relationSizes: sizes };

  assert.doesNotThrow(() => assertGrowthAccessPaths('report lookup', [sample], [relations[0]!]));
  assert.throws(
    () => assertGrowthAccessPaths('report lookup', [sample], [relations[1]!]),
    /sequential scans must be zero.*exceeds 8 pages/,
  );
  assert.throws(
    () => assertGrowthAccessPaths('report lookup', [sample], ['content.report']),
    /ambiguous.*kernel\.content\.report.*auth\.content\.report.*database and schema/,
  );
  assert.throws(
    () => assertGrowthAccessPaths('report lookup', [sample], [{ kind: 'relation', name: 'report' }]),
    /ambiguous.*database and schema/,
  );
});
