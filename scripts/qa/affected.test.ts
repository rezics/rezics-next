import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript-6';
import { planAffected, type GraphModule } from './affected.ts';
import { selectRepositoryGuards } from './repository-guards.ts';

const root = resolve(import.meta.dir, '../..');
const edge = (resolved: string) => ({ module: resolved, resolved, couldNotResolve: false, coreModule: false });

// Captured with git diff --name-only main...goal/g-2331 and goal/g-2461.
// Keep the paths fixed: landed branches and main continue moving after capture.
const recordedChanges = [
  {
    name: 'continuation inventory and recorded manga progress',
    changed: [
      'apps/web/features/tracking/manga-two-device-recorded-page.test.ts',
      'apps/web/features/tracking/manga-two-device-recorded-page.ts',
      'apps/web/features/tracking/manga-two-device-recorded-page.tsx',
      'apps/web/features/tracking/manga-two-device-recorded.stories.tsx',
      'scripts/static/web-continuations.inventory.json',
      'tests/qa/fixtures/outcomes/manga/continue-progress-across-devices-two-device-progress.json',
      'tests/qa/integration/outcomes/manga/continue-progress-across-devices-two-device-progress.test.ts',
    ],
    test: 'apps/web/features/tracking/manga-two-device-recorded-page.test.ts',
    dataConsumer: 'apps/web/features/tracking/manga-two-device-recorded-page.ts',
  },
  {
    name: 'realm outcome and recorded direct routes',
    changed: [
      'apps/web/features/realm/discussion-page.tsx',
      'apps/web/features/realm/discussions-route.tsx',
      'apps/web/features/realm/realm-closure-direct-recorded-page.test.ts',
      'apps/web/features/realm/realm-closure-direct-recorded-page.tsx',
      'apps/web/features/realm/realm-closure-direct-recorded.stories.tsx',
      'apps/web/features/realm/routes.tsx',
      'apps/web/features/zones/site-route.tsx',
      'tests/qa/fixtures/outcomes/realm/closure-direct-routes.json',
      'tests/qa/integration/outcomes/realm/closure-direct-routes.test.ts',
    ],
    test: 'apps/web/features/realm/realm-closure-direct-recorded-page.test.ts',
    dataConsumer: 'apps/web/features/realm/realm-closure-direct-recorded.stories.tsx',
  },
];

const harnessTests = ['memory-admission', 'container-reaper', 'integration-shards',
  'postgres-collation', 'run-deadline', 'core'].map(name => `tests/qa/unit/${name}.test.ts`);

function replay(changed: string[], dataConsumer?: string) {
  const guards = selectRepositoryGuards(changed).map(guard => guard.file);
  // Real source and import edges for both recorded chains, without invoking a
  // repository-wide dependency analysis inside a unit test's clock.
  const files = new Set([...changed, ...guards, ...harnessTests,
    'scripts/qa/repository-guards.ts', 'scripts/goal/unit-gate.ts', 'scripts/goal/qa-slots.ts',
    'scripts/qa/cases/launch-coverage.ts', 'scripts/qa/cases/outcomes.ts',
    'scripts/goal/regress.ts', 'scripts/qa/core.ts']);
  const sources = new Map([...files].filter(file => /\.tsx?$/.test(file)).map(file => [file,
    existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '']));
  // These recorded web files have not all landed on main. Retain their JSON
  // imports and existence while reading the registry/harness sources here.
  if (dataConsumer) sources.set(dataConsumer, sources.get(dataConsumer)! + changed
    .filter(file => file.endsWith('.json') && file.startsWith('tests/qa/fixtures/'))
    .map(file => `\nimport record from '${relative(dirname(dataConsumer), file)}';`).join('\n'));
  const graph: GraphModule[] = [...sources].map(([source, text]) => ({ source,
    dependencies: ts.preProcessFile(text, true).importedFiles
      .map(({ fileName }) => normalize(join(dirname(source), fileName)))
      .filter(file => files.has(file)).map(edge),
  }));
  return { guards, plan: planAffected({ base: 'recorded', changed, sources, graph,
    exists: file => files.has(file) || existsSync(join(root, file)), typecheckRoot: '.temp/affected-empty-root' }) };
}

for (const recording of recordedChanges) {
  test(`${recording.name} selects validating guards and web tests without unrelated harness tests`, () => {
    const { guards, plan } = replay(recording.changed, recording.dataConsumer);
    expect(guards).toContain('scripts/static/web-continuations.test.ts');
    expect(guards).toContain('scripts/api/answer-records.guard.test.ts');
    expect(guards).toContain('scripts/qa/cases/outcomes.test.ts');
    expect(guards).toContain('tests/qa/unit/test-registry.test.ts');
    for (const guard of guards) expect(plan.tests.unit).toContain(guard);
    expect(plan.frontend.find(workspace => workspace.workspace === 'apps/web')?.tests).toContain(recording.test);
    expect(plan.tests.integration).toContain(recording.changed.find(file => file.startsWith('tests/qa/integration/'))!);
    expect(plan.tests.unit.filter(file => file.startsWith('tests/qa/unit/') && !guards.includes(file))).toEqual([]);
    expect(plan.widened).toEqual([]);
  });
}

test('a harness runtime edit still selects harness consumers', () => {
  const { plan } = replay(['scripts/qa/core.ts']);
  expect(plan.tests.unit).toContain('tests/qa/unit/memory-admission.test.ts');
  expect(plan.tests.unit).toContain('tests/qa/unit/core.test.ts');
});

test('registry references are validation leaves; runtime data and subprocess inputs follow importers', () => {
  const data = 'scripts/records/runtime-record.json';
  const script = 'scripts/operations/runtime-command.ts';
  const registry = 'scripts/records/registry.ts';
  const reader = 'services/main/src/record-reader.ts';
  const runner = 'scripts/operations/runner.ts';
  const validator = 'tests/qa/unit/record-validation.test.ts';
  const runtimeTest = 'tests/qa/unit/record-runtime.test.ts';
  const commandTest = 'tests/qa/unit/command-runtime.test.ts';
  const registryTest = 'tests/qa/unit/registry-runtime.test.ts';
  const sources = new Map([
    [registry, `export const records = [{ file: '${data}', proof: register('${script}') }];
      // Bun.spawn(['bun', '${script}']); readFileSync('${data}');`],
    [validator, `const input = '${data}'; const command = '${script}';`],
    [reader, `import { readFileSync as read } from 'node:fs';
      const input = join(root, '${data}'); export const record = () => read(input, 'utf8');`],
    [runner, `const command = ['bun', '${script}']; export const run = () => Bun.spawn(command);`],
  ]);
  const graph: GraphModule[] = [
    { source: runtimeTest, dependencies: [edge(reader)] },
    { source: commandTest, dependencies: [edge(runner)] },
    { source: registryTest, dependencies: [edge(registry), edge(validator)] },
  ];
  const plan = (changed: string[], extra: GraphModule[] = []) => planAffected({ base: 'abc', changed,
    sources, graph: [...graph, ...extra], exists: () => true, typecheckRoot: '.temp/affected-empty-root' });
  expect(plan([data]).tests.unit).toEqual([runtimeTest, validator].sort());
  expect(plan([script]).tests.unit).toEqual([commandTest, validator].sort());
  expect(plan([registry]).tests.unit).toContain(registryTest);
  // An actual import of data is a runtime edge even without a textual reader.
  expect(plan([data], [{ source: registryTest, dependencies: [edge(data)] }]).tests.unit).toContain(registryTest);
});

test('directory inputs select directory readers without selecting readers of neighboring files', () => {
  const data = 'services/main/data/retained-record.json';
  const directoryReader = 'services/main/src/directory-reader.ts';
  const neighborReader = 'services/main/src/neighbor-reader.ts';
  const directoryTest = 'tests/qa/unit/directory-reader.test.ts';
  const neighborTest = 'tests/qa/unit/neighbor-reader.test.ts';
  const result = planAffected({ base: 'abc', changed: [data],
    sources: new Map([
      [directoryReader, "readFileSync(join(root, 'services/main/data/', name));"],
      [neighborReader, "readFileSync('services/main/data/other-record.json');"],
      [neighborTest, "const example = 'services/main/data/other-record.json';"],
    ]),
    graph: [
      { source: directoryTest, dependencies: [edge(directoryReader)] },
      { source: neighborTest, dependencies: [edge(neighborReader)] },
    ], exists: () => true, typecheckRoot: '.temp/affected-empty-root' });
  expect(result.tests.unit).toEqual([directoryTest]);
  expect(result.widened).toEqual([]);
});
