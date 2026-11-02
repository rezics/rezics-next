import { expect, test } from 'bun:test';
import { costOf } from './growth-cost.ts';
import { collectModifyTargets, MAX_CAPTURE_PLAN_NODES, MAX_PLAN_DEPTH, MAX_PLAN_NODES } from './growth-plan-walk.ts';
import { relationIdentityKey, type RelationIdentity } from './growth-relation-identity.ts';
import { statementAttributions, statementOccurrences } from './growth-report.ts';

function node(fields: Record<string, unknown> = {}, children?: unknown[]) {
  return {
    'Node Type': 'Result',
    'Actual Rows': 0,
    'Actual Loops': 1,
    'Shared Hit Blocks': 0,
    'Shared Read Blocks': 0,
    ...fields,
    ...(children === undefined ? {} : { Plans: children }),
  };
}

function capture(plan: unknown) {
  return { statements: ['select 1'], plans: [{ 'Query Text': 'select 1', Plan: plan }], planStatements: [0] };
}

function chain(edges: number) {
  const root = node();
  let current = root;
  for (let index = 0; index < edges; index++) {
    const child = node();
    current.Plans = [child];
    current = child;
  }
  return root;
}

function forest(size: number) {
  return {
    statements: ['select 1'],
    plans: Array.from({ length: size }, () => ({ 'Query Text': 'select 1', Plan: node() })),
    planStatements: Array.from({ length: size }, () => 0),
  };
}

test('cost and diagnostics reject cyclic and malformed plan children with their location', () => {
  const cycle = node();
  cycle.Plans = [cycle];
  const sparse: unknown[] = new Array(1);
  const invalid = [cycle, node({}, sparse), node({}, [null]), node({ Plans: null })];

  for (const plan of invalid) {
    expect(() => costOf(capture(plan))).toThrow(/plans\[0\]\.Plan\.Plans/);
    expect(() => statementOccurrences(capture(plan))).toThrow(/plans\[0\]\.Plan\.Plans/);
  }
});

test('plan traversal enforces documented depth and node limits', () => {
  expect(() => statementOccurrences(capture(chain(MAX_PLAN_DEPTH + 1)))).toThrow(/maximum depth 256/);
  expect(() =>
    costOf(
      capture(
        node(
          {},
          Array.from({ length: MAX_PLAN_NODES }, () => node()),
        ),
      ),
    ),
  ).toThrow(/maximum node count 10000/);
  const children = Array.from({ length: MAX_PLAN_NODES - 1 }, () => node());
  children[children.length - 1]!.Plans = [null];
  expect(() => costOf(capture(node({}, children)))).toThrow(/maximum node count 10000/);
});

test('cost and diagnostics bound aggregate plan nodes across a capture forest', () => {
  const supported = forest(MAX_PLAN_NODES + 1);
  expect(costOf(supported).plans).toBe(MAX_PLAN_NODES + 1);
  expect(statementOccurrences(supported).statements[0]?.plans).toHaveLength(MAX_PLAN_NODES + 1);

  const over = forest(MAX_CAPTURE_PLAN_NODES + 1);
  expect(() => costOf(over)).toThrow(/maximum node count 20000/);
  expect(() => statementOccurrences(over)).toThrow(/maximum node count 20000/);
  expect(() => statementAttributions(over)).toThrow(/maximum node count 20000/);
});

test('valid plan costs and statement diagnostics retain their measured descendants', () => {
  const plan = node({ 'Shared Hit Blocks': 3 }, [
    node({
      'Node Type': 'Seq Scan',
      Schema: 'app',
      'Relation Name': 'items',
      'Actual Rows': 3,
      'Shared Hit Blocks': 3,
    }),
  ]);
  const sample = capture(plan);

  expect(costOf(sample)).toMatchObject({ rows: 3, blocks: 3, relations: { 'app.items': { rows: 3 } } });
  expect(statementOccurrences(sample).statements[0]).toMatchObject({ rows: 3, blocks: 3 });
  expect(statementAttributions(sample)[0]).toMatchObject({ rows: 3, blocks: 3, node: 'Seq Scan app.items' });
});

function modify(schema?: string, children?: unknown[], name = 'items') {
  return node(
    {
      'Node Type': 'ModifyTable',
      ...(schema === undefined ? {} : { Schema: schema }),
      'Relation Name': name,
    },
    children,
  );
}

function writeTargets(...documents: unknown[]) {
  const output = new Map<string, RelationIdentity>();
  for (const document of documents) collectModifyTargets(document, output);
  return [...output.values()].sort((left, right) =>
    relationIdentityKey(left).localeCompare(relationIdentityKey(right)),
  );
}

function document(plan: unknown, queryText = 'insert') {
  return { 'Query Text': queryText, Plan: plan };
}

test('write-target discovery keeps schema-qualified ModifyTable targets from admitted envelopes', () => {
  const decoy = modify('decoy');
  expect(
    writeTargets(document(modify('sales')), [{ Plan: node({}, [modify('app')]) }], document(modify()), {
      ...document(node({ Extra: decoy })),
      Extra: decoy,
    }),
  ).toEqual([
    { kind: 'relation', schema: 'app', name: 'items' },
    { kind: 'relation', schema: 'public', name: 'items' },
    { kind: 'relation', schema: 'sales', name: 'items' },
  ]);
});

test('write-target discovery retains dotted and quoted schema and relation names', () => {
  expect(
    writeTargets(
      document(modify('sales.region', undefined, 'items.v1')),
      document(modify('quote"d', undefined, 'name"d')),
    ),
  ).toEqual([
    { kind: 'relation', schema: 'quote"d', name: 'name"d' },
    { kind: 'relation', schema: 'sales.region', name: 'items.v1' },
  ]);
});

test('write-target discovery fails malformed documents and bounded native trees at their location', () => {
  const output = new Map<string, RelationIdentity>();
  expect(() => collectModifyTargets({}, output)).toThrow(/plan: Unrecognized plan document/);
  expect(() => collectModifyTargets([], output)).toThrow(/plan: EXPLAIN plan document is empty/);
  expect(() => collectModifyTargets([{ Plans: [] }], output)).toThrow(/plan\[0\]: EXPLAIN plan document has no Plan/);
  expect(() => collectModifyTargets(document({ 'Node Type': 'ModifyTable' }), output)).toThrow(
    /plan\.Plan: ModifyTable is missing Relation Name/,
  );
  expect(() => collectModifyTargets(document(chain(MAX_PLAN_DEPTH + 1)), output)).toThrow(/maximum depth 256/);
  expect(() =>
    collectModifyTargets(
      document(
        node(
          {},
          Array.from({ length: MAX_PLAN_NODES }, () => node()),
        ),
      ),
      output,
    ),
  ).toThrow(/maximum node count 10000/);
  expect(output.size).toBe(0);
});
