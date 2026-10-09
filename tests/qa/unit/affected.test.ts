import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testArgs } from '../../../scripts/qa/acceptance.ts';
import { classify, erasureCampaignNativeTest, formatPlan, inputSelectedNativeTests, nativeModuleCopies, nativeModuleCopyInputs, nativeUnionTest, needsGraph, planAffected, routeTest, type GraphModule } from '../../../scripts/qa/affected.ts';
import { mergeUnitFiles, unitFilesFromPlan } from '../../../scripts/goal/goalctl.ts';
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
    'fault/recovery': ['tests/qa/fault-recovery/access-restore.test.ts'] });
  expect(result.deferred).toEqual([
    { file: 'services/main/tests/recovery.integration.test.ts', reason: 'legacy host-Jena test outside the QA registry' },
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
  const commands = affectedCommands(result).map(item => item.command);
  expect(commands.slice(1)).toEqual(
    ['owner', 'model', 'integration', 'fault/recovery'].map(tier => ['bun', ['scripts/qa/cli.ts', '--tier', tier]]));
  expect(commands[0]![1].slice(0, 3)).toEqual(['scripts/qa/cli.ts', '--tier', 'unit']);
  expect(commands[0]![1]).toContain('--file');
  expect(commands[0]![1]).not.toContain(nativeUnionTest);
  expect(commands[0]![1]).not.toContain(erasureCampaignNativeTest);
});

test('a widened unit tier still runs affected unit tests outside the registered tier', () => {
  const outside = 'tests/custom/rating.test.ts';
  const result = plan(['yarn.lock', 'services/main/src/rating.ts', 'scripts/operations/rebuild.ts'], {
    graph: graph.map(item => item.source === 'services/main/tests/rating.test.ts' ? { ...item, source: outside } : item),
    exists: path => path === outside || files.has(path),
  });
  expect(result.tests.unit).toEqual([outside]);
  const commands = affectedCommands(result).slice(0, 2).map(item => item.command);
  expect(commands[0]![1].slice(0, 3)).toEqual(['scripts/qa/cli.ts', '--tier', 'unit']);
  expect(commands[0]![1]).not.toContain(nativeUnionTest);
  expect(commands[0]![1]).not.toContain(erasureCampaignNativeTest);
  expect(commands[1]).toEqual(['bun', ['test', `./${outside}`]]);
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
    ['bun', ['scripts/qa/cli.ts', '--tier', 'fault/recovery', '--file', 'tests/qa/fault-recovery/access-restore.test.ts']],
  ]);
  expect(affectedCommands(plan(['services/main/migrations/access/020_roles.sql'])).map(item => item.command))
    .toEqual([['bun', ['scripts/qa/cli.ts', '--tier', 'integration']],
      ['bun', ['scripts/qa/cli.ts', '--tier', 'fault/recovery']]]);
});

test('migrated Main runtime fixtures select their QA tier; contract-blocked ones stay deferred', () => {
  const source = 'services/main/src/modules/semantic/command.ts';
  const integration = ['edit', 'outbox'].map(name => `services/main/tests/${name}.integration.test.ts`);
  const blocked = ['activate', 'full-work', 'recovery'].map(name => `services/main/tests/${name}.integration.test.ts`);
  const runtimeGraph = [source, ...integration, ...blocked].map(file => ({
    source: file, dependencies: file === source ? [] : [edge(source)],
  }));
  const imported = plan([source], { graph: runtimeGraph, exists: () => true });
  expect(imported.tests.integration).toEqual(integration);
  expect(imported.tests['fault/recovery']).toEqual([]);
  expect(imported.tests.owner).toEqual([]);
  expect(imported.tests.unit).toEqual([]);
  expect(imported.deferred).toEqual(blocked.map(file => (
    { file, reason: 'legacy host-Jena test outside the QA registry' })));
  for (const file of integration) {
    expect(routeTest(file)).toEqual({ tier: 'integration' });
    const direct = plan([file], { graph: runtimeGraph, exists: () => true });
    expect(affectedCommands(direct).map(item => item.command)).toEqual([
      ['bun', ['scripts/qa/cli.ts', '--tier', 'integration', '--file', file]],
    ]);
    expect(direct.deferred).toEqual([]);
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


const nativeDockerfile = `
FROM maven:pinned AS module
COPY infra/jena/command-module/pom.xml /build/pom.xml
COPY infra/jena/command-module/src /build/src
COPY services/main/src/modules/query/templates /build/src/test/resources/query-templates/
COPY generated/model/ /build/profiles/
COPY infra/jena/fuseki-text.ttl /build/fuseki-text.ttl
FROM maven:pinned AS distribution
COPY infra/jena/fuseki-text-qa.ttl /opt/qa.ttl
`.trim();

test('the native union test follows the Dockerfile module-stage COPY inputs', () => {
  const real = readFileSync(new URL('../../../infra/jena/Dockerfile', import.meta.url), 'utf8');
  const copied = nativeModuleCopies(real).map(copy => copy.source);
  expect(copied).toContain('infra/jena/command-module/src');
  expect(copied).toContain('services/main/src/modules/query/templates');
  expect(copied).toContain('generated/model/');
  expect(copied).not.toContain('infra/jena/fuseki-text-qa.ttl');
  const unionSource = readFileSync(new URL('../../../infra/jena/tests/semantic-source-readiness-union.test.ts', import.meta.url), 'utf8');
  expect(unionSource).toContain('dockerfile.split(/\\nFROM /, 1)[0]');
  expect(unionSource).toContain('/^COPY (\\S+) (\\/build\\/\\S+)$/');
  const exists = (path: string) => files.has(path) || (inputSelectedNativeTests as readonly string[]).includes(path);
  const imported = plan(['services/main/src/access.ts', 'services/main/src/rating.ts'], {
    nativeUnionDockerfile: nativeDockerfile,
    graph: [...graph, { source: nativeUnionTest, dependencies: [edge('services/main/src/access.ts')] }],
    sources: new Map([...sources, [nativeUnionTest, "readFileSync(join(root, 'services/main/src/access.ts'))"]]),
    exists,
  });
  expect(Object.values(imported.tests).flat()).not.toContain(nativeUnionTest);
  expect(Object.values(imported.tests).flat()).not.toContain(erasureCampaignNativeTest);
  expect(formatPlan(imported)).toContain(`${nativeModuleCopyInputs}: not selected`);
  expect(formatPlan(imported)).not.toContain(nativeUnionTest);
  expect(formatPlan(imported)).not.toContain(erasureCampaignNativeTest);
  expect(imported.tests.integration).toEqual(['tests/qa/integration/access-api.test.ts']);
  for (const path of ['infra/jena/Dockerfile', 'infra/jena/command-module/pom.xml',
    'infra/jena/command-module/src/main/java/com/rezics/jena/SemanticSourceBasis.java',
    'services/main/src/modules/query/templates/work-versions.schema.ts',
    'generated/model/shapes/entity.ttl']) {
    const result = plan([path], { nativeUnionDockerfile: nativeDockerfile, exists });
    expect(result.tests.unit, path).toEqual([erasureCampaignNativeTest, nativeUnionTest]);
    expect(result.nativeUnion, path).toBe('selected');
    expect(formatPlan(result)).toContain(`${nativeModuleCopyInputs}: selected`);
  }
  const ownFile = plan([nativeUnionTest], { nativeUnionDockerfile: nativeDockerfile, exists });
  expect(ownFile.tests.unit).toEqual([nativeUnionTest]);
  expect(ownFile.nativeUnion).toBe('selected');
  const erasureOwn = plan([erasureCampaignNativeTest], { nativeUnionDockerfile: nativeDockerfile, exists });
  expect(erasureOwn.tests.unit).toEqual([erasureCampaignNativeTest]);
  const laterStage = plan(['infra/jena/fuseki-text-qa.ttl'], { nativeUnionDockerfile: nativeDockerfile, exists });
  expect(laterStage.tests.unit).not.toContain(nativeUnionTest);
  expect(laterStage.tests.unit).not.toContain(erasureCampaignNativeTest);
  expect(laterStage.widened.map(item => item.tier)).toEqual(['model', 'integration', 'fault/recovery']);
  const dockerfile = plan(['infra/jena/Dockerfile'], { nativeUnionDockerfile: nativeDockerfile, exists });
  expect(dockerfile.widened.map(item => item.tier)).toEqual(['model', 'integration', 'fault/recovery']);
  expect(dockerfile.tasks[0]!.task).toBe('jena:check');
});

test('an unsupported module-stage COPY selects the native union test without breaking planning', () => {
  const dockerfile = 'FROM maven AS module\nCOPY --chmod=0755 x /build/x\n';
  expect(() => nativeModuleCopies(dockerfile)).toThrow('unsupported native module COPY:');
  const exists = (path: string) => files.has(path) || (inputSelectedNativeTests as readonly string[]).includes(path);
  const result = plan(['services/main/src/access.ts'], { nativeUnionDockerfile: dockerfile, exists });
  expect(result.tests.unit).toEqual([erasureCampaignNativeTest, nativeUnionTest]);
  expect(result.nativeUnion).toBe('unsupported COPY syntax, selected');
  expect(formatPlan(result)).toContain(`${nativeModuleCopyInputs}: unsupported COPY syntax, selected`);
});

test('a widened unit tier omits input-selected native files unless their COPY rule matched', () => {
  const exists = (path: string) => files.has(path) || (inputSelectedNativeTests as readonly string[]).includes(path);
  const lock = plan(['yarn.lock'], { nativeUnionDockerfile: nativeDockerfile, exists });
  expect(lock.widened.map(item => item.tier)).toContain('unit');
  expect(lock.nativeUnion).toBe('not selected');
  expect(lock.tests.unit).toEqual([]);
  const lockPlan = formatPlan(lock);
  expect(lockPlan).toContain('unit: tests/qa/unit');
  expect(lockPlan).not.toContain('unit: whole tier');
  expect(lockPlan).not.toContain(nativeUnionTest);
  expect(lockPlan).not.toContain(erasureCampaignNativeTest);
  const lockCommand = affectedCommands(lock).find(item => item.label === 'unit (whole tier)')!.command[1];
  expect(lockCommand.slice(0, 3)).toEqual(['scripts/qa/cli.ts', '--tier', 'unit']);
  expect(lockCommand).not.toContain(nativeUnionTest);
  expect(lockCommand).not.toContain(erasureCampaignNativeTest);
  const directory = mkdtempSync(join(tmpdir(), 'unit-native-omit-'));
  try {
    const listed = [...lockPlan.matchAll(/^  unit: (\S+)$/gm)].map(match => match[1]!);
    for (const file of listed) {
      if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), '');
    }
    mkdirSync(join(directory, 'tests/qa/unit/nested'), { recursive: true });
    writeFileSync(join(directory, 'tests/qa/unit/nested/behavior.test.ts'), '');
    for (const file of inputSelectedNativeTests) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), '');
    }
    const selected = mergeUnitFiles(directory, lockPlan);
    expect(unitFilesFromPlan(directory, lock)).toEqual(selected);
    const rewritten = lockPlan.replace(/^  unit: /gm, '  chosen: ');
    expect(mergeUnitFiles(directory, rewritten)).not.toEqual(selected);
    expect(unitFilesFromPlan(directory, lock)).toEqual(selected);
    expect(selected).not.toContain(nativeUnionTest);
    expect(selected).not.toContain(erasureCampaignNativeTest);
    expect(selected).toContain('tests/qa/unit/nested/behavior.test.ts');
    expect(selected).toContain('tests/qa/g-955-harness.test.ts');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const image = plan(['infra/jena/Dockerfile'], { nativeUnionDockerfile: nativeDockerfile, exists });
  expect(image.tests.unit).toEqual([erasureCampaignNativeTest, nativeUnionTest]);
  const imageDirectory = mkdtempSync(join(tmpdir(), 'unit-native-select-'));
  try {
    for (const file of inputSelectedNativeTests) {
      mkdirSync(dirname(join(imageDirectory, file)), { recursive: true });
      writeFileSync(join(imageDirectory, file), '');
    }
    expect(mergeUnitFiles(imageDirectory, formatPlan(image))).toEqual([...inputSelectedNativeTests].sort());
    expect(unitFilesFromPlan(imageDirectory, image)).toEqual([...inputSelectedNativeTests].sort());
  } finally {
    rmSync(imageDirectory, { recursive: true, force: true });
  }
  const widenedImage = plan(['yarn.lock', 'infra/jena/Dockerfile'], { nativeUnionDockerfile: nativeDockerfile, exists });
  expect(widenedImage.tests.unit).toEqual([erasureCampaignNativeTest, nativeUnionTest]);
  expect(formatPlan(widenedImage)).toContain(`unit: ${nativeUnionTest}`);
  expect(formatPlan(widenedImage)).toContain(`unit: ${erasureCampaignNativeTest}`);
  const widenedCommands = affectedCommands(widenedImage);
  const widenedCommand = widenedCommands.find(item => item.label === 'unit (whole tier)')!.command[1];
  expect(widenedCommand).not.toContain(nativeUnionTest);
  expect(widenedCommand).not.toContain(erasureCampaignNativeTest);
  expect(widenedCommands.some(item => item.command[1].includes(`./${nativeUnionTest}`)
    && item.command[1].includes(`./${erasureCampaignNativeTest}`))).toBe(true);
  expect(testArgs('unit')).toEqual(expect.arrayContaining([...inputSelectedNativeTests]));
});

test('affected selection defers the explicitly excluded live browser fixture', () => {
  expect(routeTest('apps/web/tests/g-944-shared-browser.test.ts')).toEqual({
    deferred: 'Live shared-stack Playwright fixture requires running web, Accounts and Main services; run it explicitly through goalctl rather than the isolated Bun unit tier.',
  });
});
