import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Script } from 'node:vm';
import ts from 'typescript-6';
import * as acceptance from '../../../scripts/qa/acceptance.ts';
import * as qaCore from '../../../scripts/qa/core.ts';
import { ownerTierBudgetMs } from '../../../scripts/qa/owner-tier-budget.ts';
import { redactCommandOutput } from '../../../scripts/fixture/command-output.ts';
import { failedSelection, nativeModuleSuiteTest, nativeProofBatchDeadline, nativeProofDeclaration, nativeProofDeclarations, testArgs } from '../../../scripts/qa/acceptance.ts';
import { NativeProofImageUnavailable, runPreparedNativeProofBatch } from '../../../scripts/qa/native-proof-execution.ts';
import { fusekiBuildInputs } from '../../../scripts/dev/fuseki-image.ts';
import { classify, erasureCampaignNativeTest, formatPlan, heldReplayNativeTest, inputSelectedNativeTests, nativeIntegerPreservationTest, nativeModuleCopies, nativeModuleCopyInputs, nativeUnionTest, needsGraph, planAffected, routeTest, typecheckWorkspaces, workNameScopeBasisTest, type GraphModule } from '../../../scripts/qa/affected.ts';
import { mergeUnitFiles, ownerFilesFromPlan, unitFilesFromPlan } from '../../../scripts/goal/goalctl.ts';
import { regressionBatchCommand, regressionRegistry } from '../../../scripts/goal/regress.ts';
import { RETAINED_SOURCE_BUILD_FILE, WORK_PROFILE_SEED_BUILD_FILE } from '../../../scripts/qa/preparation-selection.ts';
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
const nativeProofs = [erasureCampaignNativeTest, nativeIntegerPreservationTest, nativeUnionTest,
  workNameScopeBasisTest, heldReplayNativeTest, nativeModuleSuiteTest,
  'infra/jena/tests/command-module-startup.test.ts',
  'infra/jena/tests/media-summary-label-growth.test.ts',
  'infra/jena/tests/native-visit-profile.test.ts',
  'infra/jena/tests/occurrence-label-growth.test.ts',
  'infra/jena/tests/prefix-walk-native.test.ts',
  'infra/jena/tests/search-journal-restart.test.ts',
  'services/main/tests/read-snapshot-native.test.ts',
].sort();
const plan = (changed: string[], extra: Partial<Parameters<typeof planAffected>[0]> = {}) =>
  planAffected({ base: 'abc', changed, graph, sources, exists: path => files.has(path),
    // This synthetic import graph has its own project; repository membership is proved below.
    typecheckRoot: '.temp/affected-empty-root', ...extra });

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

test('native repository parser changes select its guards without widening stack tiers', () => {
  const guards = ['scripts/static/mechanism-dependencies.test.ts', 'scripts/static/web-acting-identity.test.ts',
    'tests/qa/unit/serialization-points.test.ts', 'tests/qa/unit/g-1046-sql-relations.test.ts'];
  const result = plan(['tools/repo-index/Cargo.lock', 'tools/repo-index/src/main.rs'], {
    sources: new Map(guards.map(file => [file, ''])), exists: file => guards.includes(file),
  });
  expect(result.widened).toEqual([]);
  for (const file of guards) expect(result.tests.unit).toContain(file);
});

test('outcome tree inputs select the declarations guard without an import edge', () => {
  const guard = 'scripts/qa/cases/outcomes.test.ts';
  const outcome = 'tests/qa/integration/outcomes/books/read-a-book.test.ts';
  const declaration = 'scripts/qa/cases/outcomes/books/read-a-book.ts';
  const reader = 'scripts/qa/cases/outcomes.ts';
  const present = new Set([...files, guard, outcome, declaration, reader]);
  for (const path of [outcome, declaration, reader, 'scripts/qa/cases/outcome-cells.ts',
    'tests/qa/integration/outcomes/books/proof.json', 'scripts/qa/cases/outcomes/books/removed.ts']) {
    const result = plan([path], {
      exists: file => present.has(file),
      graph: [...graph, { source: guard, dependencies: [edge(reader)] }],
      sources: new Map([...sources, [guard, "readFileSync('tests/qa/integration/outcomes/books/')"]]),
      typecheckRoot: '.temp/affected-empty-root',
    });
    expect(result.tests.unit).toContain(guard);
    expect(result.tests.owner).not.toContain(guard);
    expect(result.widened).toEqual([]);
    expect(unitFilesFromPlan(resolve(import.meta.dir, '../../..'), result, [path])).toContain(guard);
  }
  expect(plan(['tests/qa/integration/access-api.test.ts'], {
    exists: file => present.has(file),
    sources: new Map([...sources, [guard, '']]),
    typecheckRoot: '.temp/affected-empty-root',
  }).tests.unit).not.toContain(guard);
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

test('a changed script selects the script type check, and dataset tools keep theirs', () => {
  const fixture = plan(['scripts/fixture/prune.ts']);
  expect(fixture.tasks).toEqual([{ task: 'scripts:typecheck', because: 'scripts/fixture/prune.ts: script type check' }]);
  expect(formatPlan(fixture)).toContain('task scripts:typecheck');
  expect(affectedCommands(fixture).map(item => item.command)).toContainEqual(['task', ['scripts:typecheck']]);
  const both = plan(['scripts/fixture/prune.ts', 'scripts/dev/cli.ts']);
  expect(both.tasks.filter(item => item.task === 'scripts:typecheck')).toHaveLength(1);
  expect(plan(['scripts/datasets/cli.ts']).tasks).toEqual([{
    task: 'dataset:typecheck', because: 'scripts/datasets/cli.ts: script type check' }]);
  expect(plan(['services/main/src/access.ts']).tasks).toEqual([]);
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
  const commands = affectedCommands(result).map(item => item.command);
  expect(commands[0]).toEqual(['task', ['scripts:typecheck']]);
  const unit = commands.find(command => command[1][0] === 'scripts/qa/cli.ts');
  expect(unit![1].slice(0, 3)).toEqual(['scripts/qa/cli.ts', '--tier', 'unit']);
  expect(unit![1]).not.toContain(nativeUnionTest);
  expect(unit![1]).not.toContain(erasureCampaignNativeTest);
  expect(commands).toContainEqual(['bun', ['test', '--timeout=5000', `./${outside}`]]);
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

/** Execute the CLI's actual branch and runBunTier recorder; only host admission,
 * process execution, time and the current image tag are supplied by the fixture. */
function cliOwnerEntry(artifacts: string, configuration: {
  durationMs?: number; imagePresent?: boolean; env?: NodeJS.ProcessEnv;
} = {}) {
  const root = resolve(import.meta.dir, '../../..');
  const source = ts.createSourceFile('cli.ts', readFileSync(
    process.env.REZICS_QA_OWNER_MUTATION_FILE ?? join(root, 'scripts/qa/cli.ts'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['chosenFor', 'runBunTier'].includes(node.name?.text ?? ''));
  let execution: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(source) === "tier === 'unit' || tier === 'owner'") execution = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!execution || functions.length !== 2) throw new Error('Missing CLI owner execution entry');
  const compile = (text: string) => ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    transformers: { before: [context => {
      const visit = (node: ts.Node): ts.Node => ts.isMetaProperty(node)
        && node.keywordToken === ts.SyntaxKind.ImportKeyword
        ? ts.factory.createIdentifier('harnessImportMeta') : ts.visitEachChild(node, visit, context);
      return node => ts.visitNode(node, visit, ts.isSourceFile)!;
    }] },
  }).outputText;
  const body = compile(functions.map(node => node.getText(source)).join('\n')
    + `\n(async () => { const tier = 'owner'; ${execution.getText(source)} })();`);
  const helper = compile(readFileSync(join(root, 'scripts/qa/native-proof-execution.ts'), 'utf8'));
  const calls: { program: string; files: string[]; budget: number }[] = [];
  const run = async (args: string[], runId: string) => {
    const options = qaCore.parseArgs(args);
    const selection = options.onlyFailed ? acceptance.failedSelection(artifacts, options.onlyFailed) : undefined;
    const directory = join(artifacts, runId), logs = join(directory, 'logs');
    mkdirSync(logs, { recursive: true });
    const tiers: { name: qaCore.Tier; status: 'passed' | 'failed'; elapsedMs: number }[] = [];
    const errors: string[] = [];
    let now = 0;
    const commandAsync: typeof qaCore.commandAsync = async (_root, program, args, budget) => {
      const files = args.filter(arg => /\.test\.tsx?$/.test(arg));
      calls.push({ program, files, budget });
      const activeElapsedMs = program === 'bun' ? configuration.durationMs ?? 1 : 0;
      now += activeElapsedMs;
      if (program === 'bun') {
        const report = args.find(arg => arg.startsWith('--reporter-outfile='));
        if (!report) throw new Error('Owner execution did not provide its JUnit destination');
        writeFileSync(report.slice('--reporter-outfile='.length), `<testsuite>${files.map(file =>
          `<testcase name="Owner proof executed" file="${file}" />`).join('')}</testsuite>`);
      }
      const ok = program === 'docker' ? configuration.imagePresent !== false : activeElapsedMs <= budget;
      return { ok, output: ok ? '' : 'No such image', stdout: '', stderr: '', elapsedMs: activeElapsedMs,
        activeElapsedMs, admissionWaitMs: 0, timedOut: activeElapsedMs > budget };
    };
    const helperExports: Record<string, unknown> = {};
    const dependencies: Record<string, unknown> = {
      './acceptance.ts': acceptance,
      './core.ts': { ...qaCore, commandAsync },
      '../dev/fuseki-image.ts': { fusekiImageTag: () => 'rezics/fuseki:current-fixture-inputs' },
      './container-reaper.ts': { preserveReapEnvironment: (env: NodeJS.ProcessEnv) => env },
      '../fixture/command-output.ts': { redactCommandOutput },
    };
    const require = (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected owner execution dependency: ${name}`);
      return dependencies[name];
    };
    const processFixture = { env: configuration.env ?? {} };
    new Script(helper).runInNewContext({ exports: helperExports, require, process: processFixture, Error });
    dependencies['./native-proof-execution.ts'] = helperExports;
    await new Script(body).runInNewContext({ exports: {}, require, Error, process: processFixture,
      harnessImportMeta: { dir: join(root, 'scripts/qa') },
      Date: { now: () => now }, root, directory, logs, join, appendFileSync, writeFileSync,
      tiers, errors, options, selection, runDeadline: Number.MAX_SAFE_INTEGER,
      tierGroups: options.groups ?? (options.tier ? [{ tier: options.tier, files: options.files, id: options.id }] : undefined),
      testArgs: acceptance.testArgs, unitHarnessFiles: acceptance.unitHarnessFiles,
      splitTestArgs: qaCore.splitTestArgs, tierBunTestArgs: qaCore.tierBunTestArgs,
      ownerTierBudgetMs: () => ownerTierBudgetMs(processFixture.env),
      commandAsync, admitRun: async (work: () => Promise<unknown>) => work(), noteMemory: () => {},
      console: { error: () => {} },
    });
    const source = { head: 'fixture', fingerprint: 'stable', clean: true };
    const tests = acceptance.junitResults(directory, ['owner']);
    qaCore.writeSummary(directory, { runId, sourceBefore: source, sourceAfter: source,
      partial: true, cases: [], tiers, errors, tests });
    return { tiers, errors, tests, directory };
  };
  return { run, calls };
}

function ownerEntryArtifacts() {
  const scratch = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, 'owner-execution-contract-'));
}

test('CLI owner entry lets a 700-second prefix execution complete above the default deadline', async () => {
  const artifacts = ownerEntryArtifacts();
  try {
    const entry = cliOwnerEntry(artifacts, { durationMs: 700_000 });
    const result = await entry.run(['--tier', 'owner', '--file', 'infra/jena/tests/prefix-walk-native.test.ts'], 'prefix');
    expect(entry.calls).toEqual([{ program: 'bun', files: ['infra/jena/tests/prefix-walk-native.test.ts'], budget: 1_240_000 }]);
    expect(result.tiers).toEqual([{ name: 'owner', status: 'passed', elapsedMs: 700_000 }]);
  } finally { rmSync(artifacts, { recursive: true, force: true }); }
});

test('CLI owner entry records a missing image per proof and only-failed retries after preparation', async () => {
  const artifacts = ownerEntryArtifacts();
  const restart = 'infra/jena/tests/search-journal-restart.test.ts';
  const prefix = 'infra/jena/tests/prefix-walk-native.test.ts';
  try {
    const missing = cliOwnerEntry(artifacts, { imagePresent: false });
    const result = await missing.run(['--tier', 'owner', '--file', restart, '--file', prefix], 'missing');
    expect(result.tiers).toEqual([{ name: 'owner', status: 'failed', elapsedMs: 0 }]);
    expect(missing.calls.map(call => call.program)).toEqual(['docker']);
    expect(result.tests).toHaveLength(2);
    for (const test of result.tests) expect(test).toMatchObject({ failed: true, preparationFailure: true,
      detail: expect.stringContaining('native-proof-image-unavailable: build rezics/fuseki:current-fixture-inputs first') });
    expect(JSON.parse(readFileSync(join(result.directory, 'acceptance.json'), 'utf8')).tiers)
      .toEqual([{ name: 'owner', status: 'failed', elapsedMs: 0 }]);
    const prepared = cliOwnerEntry(artifacts, { imagePresent: true });
    const retried = await prepared.run(['--only-failed', 'missing'], 'retried');
    expect(prepared.calls.map(call => call.program)).toEqual(['docker', 'bun']);
    expect(prepared.calls[1]!.files.sort()).toEqual([prefix, restart].sort());
    expect(retried.tiers).toEqual([{ name: 'owner', status: 'passed', elapsedMs: 1 }]);
    expect(retried.tests.map(test => test.name)).toEqual(['Owner proof executed', 'Owner proof executed']);
  } finally { rmSync(artifacts, { recursive: true, force: true }); }
});

test('CLI owner entry executes affected mixed proofs separately with their declared deadlines', async () => {
  const artifacts = ownerEntryArtifacts();
  try {
    const result = plan([], {});
    const prefix = 'infra/jena/tests/prefix-walk-native.test.ts';
    const restart = 'infra/jena/tests/search-journal-restart.test.ts';
    result.tests.owner = [prefix, restart];
    const entry = cliOwnerEntry(artifacts, { imagePresent: true });
    let number = 0;
    for (const command of affectedCommands(result)) {
      const outcome = await entry.run(command.command[1].slice(1), `affected-${++number}`);
      expect(outcome.tiers[0]!.status).toBe('passed');
    }
    expect(entry.calls.filter(call => call.program === 'bun')).toEqual([
      { program: 'bun', files: [prefix], budget: 1_240_000 },
      { program: 'bun', files: [restart], budget: 720_000 },
    ]);
  } finally { rmSync(artifacts, { recursive: true, force: true }); }
});

test('CLI owner entry records unsupported selection and invalid deadline planning as preparation failures', async () => {
  const artifacts = ownerEntryArtifacts();
  try {
    for (const [file, env, detail] of [
      ['infra/jena/tests/not-registered.test.ts', {}, 'Selected owner path is not registered'],
      ['infra/jena/tests/prefix-walk-native.test.ts', { REZICS_QA_OWNER_BUDGET_MS: 'invalid' }, 'REZICS_QA_OWNER_BUDGET_MS must be a positive integer'],
    ] as const) {
      const entry = cliOwnerEntry(artifacts, { env });
      const result = await entry.run(['--tier', 'owner', '--file', file], `failure-${file.includes('prefix') ? 'deadline' : 'selection'}`);
      expect(result.tiers[0]!.status).toBe('failed');
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0]).toMatchObject({ file, failed: true, preparationFailure: true, detail: expect.stringContaining(detail) });
      expect(entry.calls).toEqual([]);
    }
  } finally { rmSync(artifacts, { recursive: true, force: true }); }
});

test('runtime-image proofs follow every Fuseki build input, including later-stage scripts and patches', () => {
  const root = resolve(import.meta.dir, '../../..');
  const dockerfile = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8');
  const exists = (path: string) => files.has(path) || inputSelectedNativeTests.includes(path);
  const restart = 'infra/jena/tests/search-journal-restart.test.ts';
  for (const path of fusekiBuildInputs(root)) {
    const result = plan([path], { nativeModuleDockerfile: dockerfile, exists });
    expect(result.tests.owner, path).toContain(restart);
    expect(result.tests.owner, path).toContain(nativeIntegerPreservationTest);
  }
  for (const path of ['infra/jena/fuseki-owner.sh', 'infra/jena/patches/ThriftConvert.java',
    'infra/jena/fuseki-text-qa.ttl']) {
    expect(plan([path], { nativeModuleDockerfile: dockerfile, exists }).tests.owner)
      // The full native suite also follows every Jena edit, including runtime inputs.
      .toEqual([nativeIntegerPreservationTest, nativeModuleSuiteTest, restart]);
  }
});

test('a copy-free Dockerfile has an empty input set while its own change still selects proofs', () => {
  const dockerfile = 'FROM eclipse-temurin:21\n';
  const exists = (path: string) => path === nativeUnionTest;
  const ordinary = plan(['services/main/src/access.ts'], { nativeModuleDockerfile: dockerfile, exists });
  expect(ordinary.nativeModuleCopySelection).toBe('not selected');
  expect(ordinary.tests.owner).toEqual([]);
  const image = plan(['infra/jena/Dockerfile'], { nativeModuleDockerfile: dockerfile, exists });
  expect(image.nativeModuleCopySelection).toBe('selected');
  expect(image.tests.owner).toEqual([nativeUnionTest]);
});

test('a 700-second prefix proof completes under its declared owner deadline', async () => {
  const prefix = 'infra/jena/tests/prefix-walk-native.test.ts';
  const result = await runPreparedNativeProofBatch('.', [prefix], 600_000, async budget => {
    const activeElapsedMs = 700_000;
    return { ok: activeElapsedMs <= budget, budget };
  }, { imageTag: () => { throw new Error('a module proof must not require a Fuseki image'); } });
  expect(result).toEqual({ ok: true, budget: 1_240_000 });
  expect(nativeProofBatchDeadline(['infra/jena/tests/occurrence-label-growth.test.ts'], 600_000)).toBe(1_960_000);
  expect(nativeProofBatchDeadline(['services/main/tests/read-snapshot-native.test.ts'], 600_000)).toBe(1_200_000);
  expect(nativeProofBatchDeadline([prefix, 'infra/jena/tests/occurrence-label-growth.test.ts'], 600_000)).toBe(3_200_000);
  expect(nativeProofBatchDeadline([prefix, 'services/main/tests/ordinary.test.ts'], 600_000)).toBe(1_840_000);
});

test('affected owner batches isolate every native declaration and preserve ordinary grouping', () => {
  const ordinary = ['services/main/tests/ordinary-a.test.ts', 'services/main/tests/ordinary-b.test.ts'];
  const result = plan([], {});
  result.tests.owner = [...ordinary, ...nativeProofs];
  const commands = affectedCommands(result);
  expect(commands[0]!.command).toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'owner',
    ...ordinary.flatMap(file => ['--file', file])]]);
  expect(commands.slice(1).map(item => item.command[1])).toEqual(
    nativeProofs.map(file => ['scripts/qa/cli.ts', '--tier', 'owner', '--file', file]));
  expect(new Set(nativeProofDeclarations.map(proof => proof.file)).size).toBe(nativeProofs.length);
  for (const file of nativeProofs) {
    expect(nativeProofBatchDeadline([file], 600_000)).toBeGreaterThanOrEqual(nativeProofDeclaration(file)!.deadlineMs);
  }
});

test('a missing current Fuseki image refuses explicitly before any native test executes', async () => {
  const restart = 'infra/jena/tests/search-journal-restart.test.ts';
  const events: string[] = [];
  const execute = async () => { events.push('execute'); return true; };
  const preparation = { imageTag: () => 'rezics/fuseki:changed-inputs',
    inspect: async (_root: string, image: string) => {
      events.push(`inspect:${image}`);
      return { ok: false, output: 'No such image' };
    } };
  const execution = runPreparedNativeProofBatch('.', [restart], 600_000, execute, preparation);
  await expect(execution).rejects.toBeInstanceOf(NativeProofImageUnavailable);
  await expect(execution).rejects.toMatchObject({ kind: 'native-proof-image-unavailable',
    image: 'rezics/fuseki:changed-inputs', files: [restart],
    message: `build rezics/fuseki:changed-inputs first before running ${restart}: No such image` });
  expect(events).toEqual(['inspect:rezics/fuseki:changed-inputs']);
});

test('complete-image proof batches verify one current tag before execution', async () => {
  const restart = 'infra/jena/tests/search-journal-restart.test.ts';
  const events: string[] = [];
  const result = await runPreparedNativeProofBatch('.', [restart, nativeIntegerPreservationTest], 600_000,
    async budget => { events.push('execute'); return budget; }, {
      imageTag: () => 'rezics/fuseki:current-inputs',
      inspect: async (_root, image) => { events.push(`inspect:${image}`); return { ok: true, output: 'sha256:present' }; },
    });
  expect(events).toEqual(['inspect:rezics/fuseki:current-inputs', 'execute']);
  expect(result).toBe(1_140_000);
});

test('prior unit and model native failures rerun only in their current owner registration', () => {
  const scratch = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(scratch, { recursive: true });
  const artifacts = mkdtempSync(join(scratch, 'native-failure-selection-'));
  const prior = join(artifacts, 'prior-one');
  mkdirSync(prior);
  try {
    writeFileSync(join(prior, 'acceptance.json'), JSON.stringify({ tiers: [
      { name: 'unit', status: 'failed' }, { name: 'model', status: 'failed' },
    ] }));
    const visit = 'infra/jena/tests/native-visit-profile.test.ts';
    const snapshot = 'services/main/tests/read-snapshot-native.test.ts';
    writeFileSync(join(prior, 'unit.xml'), `<testsuite><testcase name="native unit failure" file="${visit}"><failure /></testcase></testsuite>`);
    writeFileSync(join(prior, 'model.xml'), `<testsuite><testcase name="native model failure" file="${snapshot}"><failure /></testcase></testsuite>`);
    const selection = failedSelection(artifacts, 'prior-one');
    expect(selection.tiers).toEqual(['owner']);
    expect(selection.tests.map(test => [test.file, test.tier])).toEqual([[visit, 'owner'], [snapshot, 'owner']]);
    expect(testArgs('owner', selection)).toEqual([visit, snapshot, '-t',
      '^.*(?:native unit failure|native model failure)$']);
    rmSync(join(prior, 'model.xml'));
    expect(failedSelection(artifacts, 'prior-one').tiers).toEqual(['model', 'owner']);
  } finally { rmSync(artifacts, { recursive: true, force: true }); }
});

test('native module proofs follow the Dockerfile COPY inputs into the owner tier', () => {
  const real = readFileSync(new URL('../../../infra/jena/Dockerfile', import.meta.url), 'utf8');
  const copied = nativeModuleCopies(real).map(copy => copy.source);
  expect(copied).toContain('infra/jena/command-module/src');
  expect(copied).toContain('services/main/src/modules/query/templates');
  expect(copied).toContain('generated/model/');
  expect(copied).not.toContain('infra/jena/fuseki-text-qa.ttl');
  const unionSource = readFileSync(new URL('../../../infra/jena/tests/semantic-source-readiness-union.test.ts', import.meta.url), 'utf8');
  expect(unionSource).toContain('dockerfile.split(/\\nFROM /, 1)[0]');
  expect(unionSource).toContain('/^COPY (\\S+) (\\/build\\/\\S+)$/');
  const exists = (path: string) => files.has(path) || path === heldReplayNativeTest
    || (inputSelectedNativeTests as readonly string[]).includes(path);
  const imported = plan(['services/main/src/access.ts', 'services/main/src/rating.ts'], {
    nativeModuleDockerfile: nativeDockerfile,
    graph: [...graph, ...nativeProofs.map(source => ({ source,
      dependencies: [edge('services/main/src/access.ts')] }))],
    sources: new Map([...sources, ...nativeProofs.map(file =>
      [file, "readFileSync(join(root, 'services/main/src/access.ts'))"] as const)]),
    exists,
  });
  for (const file of nativeProofs) expect(Object.values(imported.tests).flat()).not.toContain(file);
  expect(formatPlan(imported)).toContain(`${nativeModuleCopyInputs}: not selected`);
  expect(formatPlan(imported)).not.toContain(nativeUnionTest);
  expect(formatPlan(imported)).not.toContain(erasureCampaignNativeTest);
  expect(imported.tests.integration).toEqual(['tests/qa/integration/access-api.test.ts']);
  for (const path of ['infra/jena/Dockerfile', 'infra/jena/command-module/pom.xml',
    'infra/jena/command-module/src/main/java/com/rezics/jena/SemanticSourceBasis.java',
    'services/main/src/modules/query/templates/work-versions.schema.ts',
    'generated/model/shapes/entity.ttl', 'generated/model/manifest.json',
    'infra/jena/fuseki-text.ttl']) {
    const result = plan([path], { nativeModuleDockerfile: nativeDockerfile, exists });
    expect(result.nativeModuleCopySelection, path).toBe('selected');
    expect(result.tests.unit, path).toEqual([]);
    expect(result.tests.owner, path).toEqual(nativeProofs);
    expect(formatPlan(result)).toContain(`${nativeModuleCopyInputs}: selected`);
  }
  for (const file of nativeProofs) {
    const ownFile = plan([file], { nativeModuleDockerfile: nativeDockerfile, exists });
    expect(routeTest(file)).toEqual({ tier: 'owner' });
    expect(ownFile.tests.owner).toEqual([file]);
    expect(ownFile.tests.unit).toEqual([]);
    expect(unitFilesFromPlan('.', ownFile)).not.toContain(file);
    expect(ownerFilesFromPlan('.', ownFile)).toContain(file);
    expect(testArgs('unit')).not.toContain(file);
    expect(testArgs('model')).not.toContain(file);
    expect(testArgs('owner')).not.toContain(file);
    expect(testArgs('owner', undefined, { files: [file] })).toEqual([file]);
  }
  const heldReplayOwn = plan([heldReplayNativeTest], { nativeModuleDockerfile: nativeDockerfile, exists });
  expect(routeTest(heldReplayNativeTest)).toEqual({ tier: 'owner' });
  expect(heldReplayOwn.tests.owner).toEqual([heldReplayNativeTest]);
  expect(heldReplayOwn.tests.unit).toEqual([]);
  expect(unitFilesFromPlan('.', heldReplayOwn)).not.toContain(heldReplayNativeTest);
  expect(ownerFilesFromPlan('.', heldReplayOwn)).toContain(heldReplayNativeTest);
  const laterStage = plan(['infra/jena/fuseki-text-qa.ttl'], { nativeModuleDockerfile: nativeDockerfile, exists });
  expect(laterStage.tests.unit).not.toContain(nativeUnionTest);
  expect(laterStage.tests.unit).not.toContain(erasureCampaignNativeTest);
  expect(laterStage.widened.map(item => item.tier)).toEqual(['model', 'integration', 'fault/recovery']);
  const dockerfile = plan(['infra/jena/Dockerfile'], { nativeModuleDockerfile: nativeDockerfile, exists });
  expect(dockerfile.widened.map(item => item.tier)).toEqual(['model', 'integration', 'fault/recovery']);
  expect(affectedCommands(dockerfile).find(item => item.label === 'model (whole tier)')!.command)
    .toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'model']]);
  expect(dockerfile.tests.unit).toEqual([]);
  expect(dockerfile.tests.owner).toEqual(nativeProofs);
  expect(affectedCommands(dockerfile).filter(item => item.label === 'owner (1 files)').map(item => item.command[1]))
    .toEqual(nativeProofs.map(file => ['scripts/qa/cli.ts', '--tier', 'owner', '--file', file]));
  for (const file of inputSelectedNativeTests) expect(testArgs('owner')).not.toContain(file);
  expect(dockerfile.tasks[0]!.task).toBe('jena:check');
});

test('an unsupported module-stage COPY selects the native union test without breaking planning', () => {
  const dockerfile = 'FROM maven AS module\nCOPY --chmod=0755 x /build/x\n';
  expect(() => nativeModuleCopies(dockerfile)).toThrow('unsupported native module COPY:');
  const exists = (path: string) => files.has(path) || (inputSelectedNativeTests as readonly string[]).includes(path);
  const result = plan(['services/main/src/access.ts'], { nativeModuleDockerfile: dockerfile, exists });
  expect(result.tests.unit).toEqual([]);
  expect(result.tests.owner).toEqual(nativeProofs);
  expect(result.nativeModuleCopySelection).toBe('unsupported COPY syntax, selected');
  expect(formatPlan(result)).toContain(`${nativeModuleCopyInputs}: unsupported COPY syntax, selected`);
});

test('a widened unit tier omits input-selected native files unless their COPY rule matched', () => {
  const exists = (path: string) => files.has(path) || (inputSelectedNativeTests as readonly string[]).includes(path);
  const lock = plan(['yarn.lock'], { nativeModuleDockerfile: nativeDockerfile, exists });
  expect(lock.widened.map(item => item.tier)).toContain('unit');
  expect(lock.nativeModuleCopySelection).toBe('not selected');
  expect(lock.tests.unit).toEqual([]);
  const lockPlan = formatPlan(lock);
  expect(lockPlan).toContain('unit: tests/qa/unit');
  expect(lockPlan).not.toContain('unit: whole tier');
  expect(lockPlan).not.toContain(nativeUnionTest);
  expect(lockPlan).not.toContain(erasureCampaignNativeTest);
  expect(lockPlan).not.toContain(nativeIntegerPreservationTest);
  expect(lockPlan).not.toContain(workNameScopeBasisTest);
  const lockCommand = affectedCommands(lock).find(item => item.label === 'unit (whole tier)')!.command[1];
  expect(lockCommand.slice(0, 3)).toEqual(['scripts/qa/cli.ts', '--tier', 'unit']);
  expect(lockCommand).not.toContain(nativeUnionTest);
  expect(lockCommand).not.toContain(erasureCampaignNativeTest);
  expect(lockCommand).not.toContain(heldReplayNativeTest);
  expect(lockCommand).not.toContain(nativeIntegerPreservationTest);
  expect(lockCommand).not.toContain(workNameScopeBasisTest);
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
    expect(selected).not.toContain(heldReplayNativeTest);
    expect(selected).not.toContain(nativeIntegerPreservationTest);
    expect(selected).not.toContain(workNameScopeBasisTest);
    expect(selected).toContain('tests/qa/unit/nested/behavior.test.ts');
    expect(selected).toContain('tests/qa/g-955-harness.test.ts');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const image = plan(['infra/jena/Dockerfile'], { nativeModuleDockerfile: nativeDockerfile, exists });
  expect(image.tests.unit).toEqual([]);
  expect(image.tests.owner).toEqual(nativeProofs);
  const imageDirectory = mkdtempSync(join(tmpdir(), 'unit-native-select-'));
  try {
    for (const file of inputSelectedNativeTests) {
      mkdirSync(dirname(join(imageDirectory, file)), { recursive: true });
      writeFileSync(join(imageDirectory, file), '');
    }
    expect(mergeUnitFiles(imageDirectory, formatPlan(image))).toEqual([]);
    expect(unitFilesFromPlan(imageDirectory, image)).toEqual([]);
    expect(ownerFilesFromPlan(imageDirectory, image)).toEqual(nativeProofs);
  } finally {
    rmSync(imageDirectory, { recursive: true, force: true });
  }
  const widenedImage = plan(['yarn.lock', 'infra/jena/Dockerfile'], { nativeModuleDockerfile: nativeDockerfile, exists });
  expect(widenedImage.tests.unit).toEqual([]);
  expect(widenedImage.tests.owner).toEqual(nativeProofs);
  expect(formatPlan(widenedImage)).not.toContain(`unit: ${erasureCampaignNativeTest}`);
  const widenedCommands = affectedCommands(widenedImage);
  const widenedCommand = widenedCommands.find(item => item.label === 'unit (whole tier)')!.command[1];
  expect(widenedCommand).not.toContain(nativeUnionTest);
  expect(widenedCommand).not.toContain(erasureCampaignNativeTest);
  expect(widenedCommand).not.toContain(heldReplayNativeTest);
  expect(widenedCommand).not.toContain(nativeIntegerPreservationTest);
  expect(widenedCommand).not.toContain(workNameScopeBasisTest);
  expect(widenedCommands.some(item => item.label === 'model (whole tier)')).toBe(true);
  expect(widenedCommands.some(item => item.label === 'owner (whole tier)')).toBe(true);
  const broadOwnerCommand = widenedCommands.find(item => item.label === 'owner (whole tier)')!.command[1];
  for (const file of inputSelectedNativeTests) expect(broadOwnerCommand).not.toContain(file);
  expect(widenedCommands.filter(item => item.label === 'owner (1 files)').map(item => item.command[1]))
    .toEqual(nativeProofs.map(file => ['scripts/qa/cli.ts', '--tier', 'owner', '--file', file]));
  expect(widenedCommands.some(item => item.label === 'unit (1 files)'
    && item.command[1].includes(`./${erasureCampaignNativeTest}`))).toBe(false);
  expect(testArgs('unit')).not.toContain(erasureCampaignNativeTest);
  for (const file of [nativeIntegerPreservationTest, nativeUnionTest, workNameScopeBasisTest])
    expect(testArgs('unit')).not.toContain(file);
  for (const file of inputSelectedNativeTests) expect(testArgs('owner')).not.toContain(file);
  expect(ownerFilesFromPlan('.', widenedImage)).toEqual(expect.arrayContaining(nativeProofs));
});

test('main-wide regression stages module-input native proofs with the Jena image checks', async () => {
  const registry = await regressionRegistry(resolve(import.meta.dir, '../../..'));
  const batchId = 'jena-check-2';
  const artifactDirectory = resolve('.temp/goal/regress/planner/batches', batchId, 'attempt-1');
  const junitXmlPath = join(artifactDirectory, 'batch.xml');
  for (const file of inputSelectedNativeTests) {
    expect(registry.filter(item => item.file === file)).toEqual([
      { file, tier: 'jena:check', outcome: 'pending' },
    ]);
    expect(registry.some(item => item.file === file && (item.tier === 'unit' || item.tier === 'owner'))).toBe(false);
    const command = regressionBatchCommand({ id: batchId, tier: 'jena:check', files: [file],
      state: 'pending', attempts: [] }, join(artifactDirectory, 'slot.json'), junitXmlPath);
    expect(command).toEqual([
      'bun', resolve('scripts/goal/goalctl.ts'), 'slot', '--',
      'bun', resolve('scripts/qa/host-admission.ts'), '--gib', '4', '--',
      'bun', 'test', `--preload=${resolve('scripts/qa/container-reaper.ts')}`,
      '--reporter=junit', `--reporter-outfile=${junitXmlPath}`, file,
    ]);
  }
});

test('affected selection defers retained seed preparation even when its own file changes', () => {
  const reason = 'Retained seed preparation; select its build command explicitly alone';
  expect(routeTest(WORK_PROFILE_SEED_BUILD_FILE)).toEqual({ deferred: reason });
  const result = plan([WORK_PROFILE_SEED_BUILD_FILE], { exists: () => true });
  expect(Object.values(result.tests).flat()).not.toContain(WORK_PROFILE_SEED_BUILD_FILE);
  expect(result.deferred).toContainEqual({ file: WORK_PROFILE_SEED_BUILD_FILE, reason });
});

test('affected selection defers retained source repair even when its own file changes', () => {
  const reason = 'Retained source preparation; select its build command explicitly alone';
  expect(routeTest(RETAINED_SOURCE_BUILD_FILE)).toEqual({ deferred: reason });
  const result = plan([RETAINED_SOURCE_BUILD_FILE], { exists: () => true });
  expect(Object.values(result.tests).flat()).not.toContain(RETAINED_SOURCE_BUILD_FILE);
  expect(result.deferred).toContainEqual({ file: RETAINED_SOURCE_BUILD_FILE, reason });
});

for (const size of [128, 256]) {
  test(`affected references traverse ${size} source files once for ${size} changed inputs`, () => {
    let visits = 0;
    class CountedSources extends Map<string, string> {
      override *[Symbol.iterator](): MapIterator<[string, string]> {
        for (const entry of super[Symbol.iterator]()) { visits++; yield entry; }
      }
    }
    const changed = Array.from({ length: size }, (_, index) => `scripts/input-${index}.ts`);
    const sourceFiles = changed.map((path, index) => [`tests/qa/unit/reference-${index}.test.ts`,
      `Bun.spawn(['bun', '${path}']);`] as const);
    const result = plan(changed, { graph: [], sources: new CountedSources(sourceFiles), exists: () => true });
    expect(result.tests.unit).toEqual(sourceFiles.map(([file]) => file).sort());
    expect(result.widened).toEqual([]);
    expect(visits).toBe(size);
  });
}

test('affected references retain overlapping directory, full-path and basename matches', () => {
  const changed = ['tests/qa/fixtures/retained-input.json', 'scripts/input.ts'];
  const result = plan(changed, { graph: [], exists: () => true,
    sources: new Map([
      ['tests/qa/unit/directory.test.ts', "readFileSync('tests/qa/fixtures/', name)"],
      ['tests/qa/unit/path.test.ts', "readFileSync('tests/qa/fixtures/retained-input.json')"],
      ['tests/qa/unit/name.test.ts', "readFileSync(join(root, 'retained-input.json'))"],
      ['tests/qa/unit/process.test.ts', "Bun.spawn(['bun', 'scripts/input.ts'])"],
      ['tests/qa/unit/unrelated.test.ts', "readFileSync('other.json')"],
    ]) });
  expect(result.tests.unit).toEqual(['directory', 'name', 'path', 'process']
    .map(name => `tests/qa/unit/${name}.test.ts`));
  expect(result.widened).toEqual([]);
});

for (const size of [64, 128]) {
  test(`script membership follows ${size} transitive imports without loading library ASTs`, () => {
    const directory = mkdtempSync(resolve('.temp/affected-membership-'));
    try {
      mkdirSync(join(directory, 'scripts'));
      mkdirSync(join(directory, 'tests'));
      const config = { compilerOptions: { moduleResolution: 'Bundler', module: 'ESNext',
        noLib: true, types: [], baseUrl: '.', paths: { '@proof/*': ['tests/*'] } }, include: ['*.ts'] };
      writeFileSync(join(directory, 'scripts/tsconfig.json'), JSON.stringify({ ...config,
        compilerOptions: { ...config.compilerOptions, baseUrl: '..' } }));
      writeFileSync(join(directory, 'scripts/entry.ts'),
        'import type { Proof } from "@proof/proof-0.js"; export type Entry = Proof;');
      for (let index = 0; index < size; index++) writeFileSync(join(directory, `tests/proof-${index}.ts`),
        index + 1 < size ? `export type { Proof } from './proof-${index + 1}.js';` : 'export type Proof = string;');
      writeFileSync(join(directory, 'tests/unrelated.ts'), 'export type Unrelated = string;');
      const loaded = ts.readConfigFile(join(directory, 'scripts/tsconfig.json'), ts.sys.readFile);
      const project = ts.parseJsonConfigFileContent(loaded.config, ts.sys, join(directory, 'scripts'));
      const oracle = new Set(ts.createProgram(project.fileNames, project.options).getSourceFiles()
        .map(source => resolve(source.fileName)));
      const importGraph: GraphModule[] = [
        { source: 'scripts/entry.ts', dependencies: [edge('tests/proof-0.ts')] },
        ...Array.from({ length: size }, (_, index) => ({ source: `tests/proof-${index}.ts`,
          dependencies: index + 1 < size ? [edge(`tests/proof-${index + 1}.ts`)] : [] })),
      ];
      const candidates = [`tests/proof-${size - 1}.ts`, 'tests/unrelated.ts'];
      for (const file of candidates) {
        const included = oracle.has(resolve(directory, file));
        expect(typecheckWorkspaces([file], directory).includes('scripts')).toBe(included);
        const result = plan([file], { graph: importGraph, sources: new Map(), exists: () => true,
          typecheckRoot: directory });
        expect(result.tasks.some(item => item.task === 'scripts:typecheck')).toBe(included);
        const incomplete = plan([file], { graph: [], sources: new Map(), exists: () => true,
          typecheckRoot: directory });
        expect(incomplete.tasks.some(item => item.task === 'scripts:typecheck')).toBe(included);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('affected selection defers the explicitly excluded live browser fixture', () => {
  expect(routeTest('apps/web/tests/g-944-shared-browser.test.ts')).toEqual({
    deferred: 'Live shared-stack Playwright fixture requires running web, Accounts and Main services; run it explicitly through goalctl rather than the isolated Bun unit tier.',
  });
});
