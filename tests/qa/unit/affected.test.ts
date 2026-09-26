import { expect, test } from 'bun:test';
import { classify, needsGraph, planAffected, type GraphModule } from '../../../scripts/qa/affected.ts';
import { affectedCommands, parseAffectedArgs } from '../../../scripts/qa/test.ts';

const edge = (resolved: string, module = resolved) => ({ module, resolved, couldNotResolve: false, coreModule: false });
const graph: GraphModule[] = [
  { source: 'services/main/src/access.ts', dependencies: [] },
  { source: 'services/main/src/app.ts', dependencies: [edge('services/main/src/access.ts')] },
  { source: 'services/main/src/rating.ts', dependencies: [] },
  { source: 'services/main/tests/rating.test.ts', dependencies: [edge('services/main/src/rating.ts')] },
  { source: 'tests/qa/integration/access-api.test.ts', dependencies: [edge('services/main/src/app.ts')] },
  { source: 'tests/qa/integration/shared-stack.test.ts', dependencies: [] },
  { source: 'tests/qa/integration/go-api.test.ts', dependencies: [] },
  { source: 'tests/qa/fault-recovery/access-restore.test.ts', dependencies: [edge('services/main/src/access.ts')] },
  { source: 'tests/qa/load/practical.test.ts', dependencies: [edge('services/main/src/app.ts')] },
  { source: 'services/main/tests/recovery.integration.test.ts', dependencies: [edge('services/main/src/app.ts')] },
  { source: 'tests/qa/unit/rebuild.test.ts', dependencies: [] },
];
const sources = new Map<string, string>([
  ['tests/qa/integration/go-api.test.ts', "readFileSync(join(root, 'tests/qa/fixtures/', name))"],
  ['tests/qa/unit/rebuild.test.ts', "Bun.spawn(['bun', 'scripts/operations/rebuild.ts'])"],
]);
const files = new Set([...graph.map(module => module.source), 'scripts/operations/rebuild.ts']);
const plan = (changed: string[], extra: Partial<Parameters<typeof planAffected>[0]> = {}) =>
  planAffected({ base: 'abc', changed, graph, sources, exists: path => files.has(path), ...extra });

test('a changed module selects every test that reaches it and routes each to its tier', () => {
  const result = plan(['services/main/src/access.ts']);
  expect(result.tests).toEqual({ unit: [], model: [],
    integration: ['tests/qa/integration/access-api.test.ts'],
    'fault/recovery': ['tests/qa/fault-recovery/access-restore.test.ts'] });
  expect(result.deferred).toEqual([
    { file: 'services/main/tests/recovery.integration.test.ts', reason: 'legacy host-Jena test outside the QA registry' },
    { file: 'tests/qa/load/practical.test.ts', reason: 'capacity tier; run explicitly with yarn test <file>' },
  ]);
  expect(result.widened).toEqual([]);
});

test('documentation and static configuration select no tests', () => {
  const result = plan(['docs/testing/test-harness.md', 'biome.json', 'services/main/tsconfig.json',
    'scripts/static/ast-grep/rules/no-dynamic-code.yml']);
  expect(Object.values(result.tests).flat()).toEqual([]);
  expect(result.widened).toEqual([]);
  expect(result.ignored.map(item => item.path)).toEqual(['biome.json', 'docs/testing/test-harness.md',
    'scripts/static/ast-grep/rules/no-dynamic-code.yml', 'services/main/tsconfig.json']);
});

test('inputs outside the import graph widen to the tiers that load them', () => {
  const migration = plan(['services/main/migrations/access/020_roles.sql', 'services/main/src/access.ts']);
  expect(migration.widened.map(item => item.tier)).toEqual(['integration', 'fault/recovery']);
  expect(migration.tests.integration).toEqual([]);
  expect(plan(['infra/jena/command-module/src/Command.java']).widened.map(item => item.tier))
    .toEqual(['model', 'integration', 'fault/recovery']);
  expect(classify('infra/dev/tests/compose.test.ts')).toBeUndefined();
});

test('only graph-selected changes build the import graph', () => {
  expect(needsGraph(['docs/testing/test-harness.md', 'biome.json', 'yarn.lock', 'infra/dev/compose.yaml'])).toBe(false);
  expect(needsGraph(['package.json'], new Set(['package.json']))).toBe(true);
  expect(needsGraph(['services/main/src/app.ts'])).toBe(true);
});

test('an unreferenced input fails closed to every registered tier', () => {
  const result = plan(['services/main/data/unknown.bin']);
  expect(result.widened.map(item => item.tier)).toEqual(['unit', 'model', 'integration', 'fault/recovery']);
  expect(affectedCommands(result).map(item => item.command)).toEqual(
    ['unit', 'model', 'integration', 'fault/recovery'].map(tier => ['corepack', ['yarn', 'qa', '--tier', tier]]));
});

test('a widened unit tier still runs affected unit tests outside the registered tier', () => {
  const result = plan(['yarn.lock', 'services/main/src/rating.ts', 'scripts/operations/rebuild.ts']);
  // tests/qa/unit is registered, so only the service test runs separately.
  expect(result.tests.unit).toEqual(['services/main/tests/rating.test.ts']);
  expect(affectedCommands(result).slice(0, 2).map(item => item.command)).toEqual([
    ['corepack', ['yarn', 'qa', '--tier', 'unit']], ['bun', ['test', './services/main/tests/rating.test.ts']]]);
});

test('data files, deleted modules and spawned scripts reach tests without import edges', () => {
  expect(plan(['tests/qa/fixtures/go-sumdb-latest.json']).tests.integration)
    .toEqual(['tests/qa/integration/go-api.test.ts']);
  expect(plan(['scripts/operations/rebuild.ts']).tests.unit).toEqual(['tests/qa/unit/rebuild.test.ts']);
  const deleted = planAffected({ base: 'abc', changed: ['services/main/src/gone.ts'], sources, exists: path => files.has(path),
    graph: [...graph, { source: 'services/main/tests/gone.test.ts', dependencies: [
      { module: '../src/gone.ts', resolved: '../src/gone.ts', couldNotResolve: true, coreModule: false }] }] });
  expect(deleted.tests.unit).toEqual([]);
  const withFile = planAffected({ base: 'abc', changed: ['services/main/src/gone.ts'], sources,
    exists: path => files.has(path) || path === 'services/main/tests/gone.test.ts',
    graph: [...graph, { source: 'services/main/tests/gone.test.ts', dependencies: [
      { module: '../src/gone.ts', resolved: '../src/gone.ts', couldNotResolve: true, coreModule: false }] }] });
  expect(withFile.tests.unit).toEqual(['services/main/tests/gone.test.ts']);
});

test('stack harness and root script wiring add the shared-stack smoke test instead of every tier', () => {
  expect(plan(['scripts/dev/cli.ts']).tests.integration).toEqual(['tests/qa/integration/shared-stack.test.ts']);
  const scripts = plan(['package.json'], { scriptOnlyManifests: new Set(['package.json']) });
  expect(scripts.widened).toEqual([]);
  expect(scripts.tests.integration).toEqual(['tests/qa/integration/shared-stack.test.ts']);
  expect(plan(['package.json']).widened.map(item => item.tier))
    .toEqual(['unit', 'model', 'integration', 'fault/recovery']);
  expect(plan(['package.json']).tests.integration).toEqual([]);
});

test('affected arguments accept an optional revision and list mode only', () => {
  expect(parseAffectedArgs(['a.test.ts'])).toBeUndefined();
  expect(parseAffectedArgs(['--affected'])).toEqual({ list: false });
  expect(parseAffectedArgs(['--affected', 'HEAD~3', '--list'])).toEqual({ ref: 'HEAD~3', list: true });
  expect(parseAffectedArgs(['--list', '--affected=main'])).toEqual({ ref: 'main', list: true });
  expect(() => parseAffectedArgs(['--affected', 'tests/qa/unit/core.test.ts'])).toThrow('cannot be combined');
  expect(() => parseAffectedArgs(['--affected', '-t', 'IAM01'])).toThrow('cannot be combined');
  expect(() => parseAffectedArgs(['--list'])).toThrow('--list requires --affected');
});

test('affected commands run unit files directly and stack tiers through the QA harness', () => {
  const result = plan(['services/main/src/access.ts', 'services/main/src/rating.ts']);
  expect(affectedCommands(result).map(item => item.command)).toEqual([
    ['bun', ['test', './services/main/tests/rating.test.ts']],
    ['corepack', ['yarn', 'qa', '--tier', 'integration', '--file', 'tests/qa/integration/access-api.test.ts']],
    ['corepack', ['yarn', 'qa', '--tier', 'fault/recovery', '--file', 'tests/qa/fault-recovery/access-restore.test.ts']],
  ]);
  expect(affectedCommands(plan(['services/main/migrations/access/020_roles.sql'])).map(item => item.command))
    .toEqual([['corepack', ['yarn', 'qa', '--tier', 'integration']],
      ['corepack', ['yarn', 'qa', '--tier', 'fault/recovery']]]);
});
