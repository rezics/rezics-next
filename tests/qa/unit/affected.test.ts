import { expect, test } from 'bun:test';
import { classify, formatPlan, needsGraph, planAffected, routeTest, type GraphModule } from '../../../scripts/qa/affected.ts';
import { affectedCommands, parseAffectedArgs, runAffected } from '../../../scripts/qa/test.ts';

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
  expect(result.tests).toEqual({ unit: [], owner: [], model: [],
    integration: ['tests/qa/integration/access-api.test.ts'],
    'fault/recovery': ['services/main/tests/recovery.integration.test.ts',
      'tests/qa/fault-recovery/access-restore.test.ts'] });
  expect(result.deferred).toEqual([
    { file: 'tests/qa/load/practical.test.ts', reason: 'capacity tier; run explicitly with task test -- <file>' },
  ]);
  expect(result.widened).toEqual([]);
});

test('documentation and static configuration select no tests', () => {
  const result = plan(['docs/testing/test-harness.md', '.oxfmtrc.json', 'services/main/tsconfig.json',
    'scripts/static/ast-grep/rules/no-dynamic-code.yml']);
  expect(Object.values(result.tests).flat()).toEqual([]);
  expect(result.widened).toEqual([]);
  expect(result.ignored.map(item => item.path)).toEqual(['.oxfmtrc.json', 'docs/testing/test-harness.md',
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

test('Jena image and authored Turtle changes select the pinned CLI check once', () => {
  for (const path of ['infra/jena/command-module/src/Command.java', 'infra/jena/fuseki-text.ttl',
    'model/definitions/core/entity.ttl', 'model/definitions/profiles/book.ttl']) {
    const result = plan([path]);
    expect(result.tasks).toEqual([{ task: 'jena:check', because: `${path}: pinned Jena CLI input` }]);
    expect(affectedCommands(result)[0]!.command).toEqual(['task', ['jena:check']]);
    expect(formatPlan(result)).toContain('task jena:check');
  }
  const result = plan(['infra/jena/fuseki-text.ttl', 'model/definitions/core/entity.ttl']);
  expect(affectedCommands(result).filter(item => item.label === 'jena:check')).toHaveLength(1);
});

test('Jena CLI staged query, shapes, fixture and image pin inputs select the same check', () => {
  for (const path of ['generated/model/shapes/entity.ttl', 'tests/fixtures/jena-cli/scratch.trig',
    'services/main/src/modules/query/templates/work-versions.rq',
    'services/main/src/modules/query/templates/work-versions.fixture.json',
    'scripts/qa/jena-cli.ts', 'infra/dev/compose.yaml']) {
    expect(affectedCommands(plan([path]))[0]!.command).toEqual(['task', ['jena:check']]);
  }
  expect(plan(['tests/fixtures/unrelated.ttl']).tasks).toEqual([]);
  expect(plan(['model/definitions/package.json']).tasks).toEqual([]);
});

test('affected execution runs Jena once and preserves its refusal alongside other failures', async () => {
  const result = plan(['infra/jena/fuseki-text.ttl', 'model/definitions/core/entity.ttl']);
  const calls: [string, string[]][] = [];
  const outcome = await runAffected(result, async command => {
    calls.push(command);
    return command[0] === 'task' ? 1 : 0;
  });
  expect(calls).toEqual(affectedCommands(result).map(item => item.command));
  expect(outcome.failed).toBe(true);
  expect(outcome.results[0]).toBe('  jena:check: failed (exit 1)');
});

test('only graph-selected changes build the import graph', () => {
  expect(needsGraph(['docs/testing/test-harness.md', '.oxfmtrc.json', 'yarn.lock', 'infra/dev/compose.yaml'])).toBe(false);
  expect(needsGraph(['package.json'], new Set(['package.json']))).toBe(true);
  expect(needsGraph(['services/main/src/app.ts'])).toBe(true);
});

test('an unreferenced input fails closed to every registered tier', () => {
  const result = plan(['services/main/data/unknown.bin']);
  expect(result.widened.map(item => item.tier)).toEqual(['unit', 'owner', 'model', 'integration', 'fault/recovery']);
  expect(affectedCommands(result).map(item => item.command)).toEqual(
    ['unit', 'owner', 'model', 'integration', 'fault/recovery'].map(tier => ['bun', ['scripts/qa/cli.ts', '--tier', tier]]));
});

test('a widened unit tier still runs affected unit tests outside the registered tier', () => {
  const outside = 'tests/custom/rating.test.ts';
  const result = plan(['yarn.lock', 'services/main/src/rating.ts', 'scripts/operations/rebuild.ts'], {
    graph: graph.map(item => item.source === 'services/main/tests/rating.test.ts' ? { ...item, source: outside } : item),
    exists: path => path === outside || files.has(path),
  });
  expect(result.tests.unit).toEqual([outside]);
  expect(affectedCommands(result).slice(0, 2).map(item => item.command)).toEqual([
    ['bun', ['scripts/qa/cli.ts', '--tier', 'unit']], ['bun', ['test', `./${outside}`]]]);
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
  expect(withFile.tests.owner).toEqual(['services/main/tests/gone.test.ts']);
});

test('stack harness and root script wiring add the shared-stack smoke test instead of every tier', () => {
  expect(plan(['scripts/dev/cli.ts']).tests.integration).toEqual(['tests/qa/integration/shared-stack.test.ts']);
  const scripts = plan(['package.json'], { scriptOnlyManifests: new Set(['package.json']) });
  expect(scripts.widened).toEqual([]);
  expect(scripts.tests.integration).toEqual(['tests/qa/integration/shared-stack.test.ts']);
  expect(plan(['package.json']).widened.map(item => item.tier))
    .toEqual(['unit', 'owner', 'model', 'integration', 'fault/recovery']);
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
    ['bun', ['scripts/qa/cli.ts', '--tier', 'owner', '--file', 'services/main/tests/rating.test.ts']],
    ['bun', ['scripts/qa/cli.ts', '--tier', 'integration', '--file', 'tests/qa/integration/access-api.test.ts']],
    ['bun', ['scripts/qa/cli.ts', '--tier', 'fault/recovery',
      '--file', 'services/main/tests/recovery.integration.test.ts',
      '--file', 'tests/qa/fault-recovery/access-restore.test.ts']],
  ]);
  expect(affectedCommands(plan(['services/main/migrations/access/020_roles.sql'])).map(item => item.command))
    .toEqual([['bun', ['scripts/qa/cli.ts', '--tier', 'integration']],
      ['bun', ['scripts/qa/cli.ts', '--tier', 'fault/recovery']]]);
});

test('migrated Main runtime fixtures select their QA tiers for direct and imported changes', () => {
  const source = 'services/main/src/modules/semantic/command.ts';
  const integration = ['activate', 'edit', 'outbox'].map(name => `services/main/tests/${name}.integration.test.ts`);
  const recovery = 'services/main/tests/recovery.integration.test.ts';
  const legacy = 'services/main/tests/full-work.integration.test.ts';
  const runtimeGraph = [source, ...integration, recovery, legacy].map(file => ({
    source: file, dependencies: file === source ? [] : [edge(source)],
  }));
  const imported = plan([source], { graph: runtimeGraph, exists: () => true });
  expect(imported.tests.integration).toEqual(integration);
  expect(imported.tests['fault/recovery']).toEqual([recovery]);
  expect(imported.tests.owner).toEqual([]);
  expect(imported.tests.unit).toEqual([]);
  expect(imported.deferred).toEqual([
    { file: legacy, reason: 'legacy host-Jena test outside the QA registry' },
  ]);
  for (const [tier, selected] of [['integration', integration], ['fault/recovery', [recovery]]] as const) {
    for (const file of selected) {
      expect(routeTest(file)).toEqual({ tier });
      const direct = plan([file], { graph: runtimeGraph, exists: () => true });
      expect(affectedCommands(direct).map(item => item.command)).toEqual([
        ['bun', ['scripts/qa/cli.ts', '--tier', tier, '--file', file]],
      ]);
      expect(direct.deferred).toEqual([]);
    }
  }
});


test('frontend-only changes list their workspace checks and run only targeted cheap checks', async () => {
  const source = 'apps/web/features/feed/state.ts';
  const test = 'apps/web/tests/feed-state.test.ts';
  const ui = 'packages/ui/src/button.tsx';
  const component = 'packages/ui/src/button.test.tsx';
  const result = plan([source, ui], {
    graph: [
      { source, dependencies: [] }, { source: test, dependencies: [edge(source)] },
      { source: ui, dependencies: [] }, { source: component, dependencies: [edge(ui)] },
    ], exists: () => true,
  });
  expect(affectedCommands(result).map(item => item.command)).toEqual([
    ['task', ['web:typecheck']], ['bun', ['test', './' + test]],
    ['task', ['ui:typecheck']], ['bun', ['test', './' + component]],
  ]);
  const executed: [string, string[]][] = [];
  const run = await runAffected(result, async command => {
    executed.push(command);
    return executed.length === 1 ? 1 : 0;
  });
  expect(executed).toEqual(affectedCommands(result).map(item => item.command));
  expect(run.failed).toBe(true);
  expect(run.results).toHaveLength(4);
  const output = formatPlan(result);
  for (const command of ['task web:typecheck', 'task ui:typecheck', 'task storybook:test', 'task web:e2e']) {
    expect(output).toContain(command);
  }
  expect(output).toContain('not run:');
  expect(output).toContain('program tier');
  expect(output).not.toContain('no affected backend tests');
  expect(result.ignored).toEqual([]);
});

test('Accounts and About retain their own checks, including non-code and documentation changes', () => {
  const result = plan(['apps/accounts/messages/en.json', 'apps/about/README.md']);
  expect(affectedCommands(result).map(item => item.command)).toEqual([
    ['task', ['accounts:typecheck']], ['task', ['about:check']],
  ]);
  expect(formatPlan(result)).toContain('task accounts:storybook:test');
  expect(formatPlan(result)).toContain('task accounts:e2e');
  expect(needsGraph(['apps/accounts/messages/en.json', 'apps/about/README.md'])).toBe(true);
  expect(needsGraph(['apps/about/README.md'])).toBe(false);
  expect(needsGraph(['apps/web/features/feed/state.ts'])).toBe(true);
});


test('frontend data, deleted code, direct test edits and UI consumers remain targeted', () => {
  const ui = 'packages/ui/src/components/work-cover.tsx';
  const consumer = 'apps/web/tests/catalogue-face.test.ts';
  const data = 'apps/accounts/messages/en.json';
  const catalog = 'apps/accounts/tests/catalogs.test.ts';
  const deleted = 'apps/web/features/removed.ts';
  const importer = 'apps/web/tests/removed.test.ts';
  const result = plan([ui, data, deleted, consumer], {
    graph: [
      { source: consumer, dependencies: [edge(ui)] },
      { source: catalog, dependencies: [edge(data)] },
      { source: importer, dependencies: [{ module: '../features/removed.ts', resolved: '../features/removed.ts',
        coreModule: false, couldNotResolve: true }] },
    ], exists: path => path !== deleted,
  });
  expect(result.frontend.map(item => [item.workspace, item.tests])).toEqual([
    ['apps/web', [consumer, importer]], ['apps/accounts', [catalog]], ['packages/ui', []],
  ]);
  expect(result.widened).toEqual([]);
  expect(Object.values(result.tests).flat()).toEqual([]);
});


test('frontend workspace metadata does not schedule stacks through broad directory text matches', () => {
  const file = 'tests/qa/integration/source-contract.test.ts';
  const result = plan(['packages/ui/package.json'], {
    graph: [{ source: file, dependencies: [] }],
    sources: new Map([[file, "readFileSync('packages/ui/src/components/button.tsx')"]]),
    exists: () => true,
  });
  expect(Object.values(result.tests).flat()).toEqual([]);
  expect(result.widened).toEqual([]);
  expect(affectedCommands(result).map(item => item.command)).toEqual([['task', ['ui:typecheck']]]);
});


test('affected selection defers the explicitly excluded live browser fixture', () => {
  expect(routeTest('apps/web/tests/g-944-shared-browser.test.ts')).toEqual({
    deferred: 'Live shared-stack Playwright fixture requires running web, Accounts and Main services; run it explicitly through goalctl rather than the isolated Bun unit tier.',
  });
});
