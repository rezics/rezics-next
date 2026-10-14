import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerTypeCommands, workerTypePlans } from './worker-types.ts';
const scratch = join(import.meta.dir, '../../.temp/worker-type-tests');
const roots: string[] = [];
function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'project-')); roots.push(root);
  const write = (file: string, text: string) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
  const config = JSON.stringify({ compilerOptions: { noLib: true, types: [], moduleResolution: 'Bundler', module: 'ESNext',
    paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts'] });
  write('services/main/tsconfig.json', config);
  write('services/main/src/value.ts', 'export interface Value { name: string }');
  write('services/main/src/use.ts', "import type { Value } from '@/value'; export type Used = Value;");
  write('services/main/src/public.ts', "export type { Used } from './use';");
  write('services/main/src/elsewhere.ts', 'export const other = 1;');
  return { root, write };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('changed sources include transitive type-only importers and aliases, excluding unrelated sources', () => {
  const f = fixture();
  expect(workerTypePlans(f.root, ['services/main/src/value.ts'])).toEqual([{ workspace: 'main', project: 'services/main/tsconfig.json',
    files: ['services/main/src/public.ts', 'services/main/src/use.ts', 'services/main/src/value.ts'] }]);
  expect(workerTypeCommands(f.root, ['services/main/src/value.ts'])[0]!.slice(0, 5))
    .toEqual(['task', 'goal:type-files', '--', '--project', 'services/main/tsconfig.json']);
});

test('deleted sources still select their importers so unresolved imports fail', () => {
  const f = fixture(); rmSync(join(f.root, 'services/main/src/value.ts'));
  expect(workerTypePlans(f.root, ['services/main/src/value.ts'])[0]!.files)
    .toEqual(['services/main/src/public.ts', 'services/main/src/use.ts']);
});

test.each(['services/main/tsconfig.json', 'services/main/package.json', 'package.json', 'yarn.lock'])('configuration %s selects the full project', file => {
  const f = fixture(); expect(workerTypePlans(f.root, [file])).toEqual([{ workspace: 'main', project: 'services/main/tsconfig.json' }]);
});

test('a shared package change reaches every importing project', () => {
  const f = fixture();
  f.write('packages/model/tsconfig.json', JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['src/*.ts'] }));
  f.write('packages/model/src/value.ts', 'export interface Value { name: string }');
  f.write('services/main/src/value.ts', "export type { Value } from '../../../packages/model/src/value';");
  expect(workerTypePlans(f.root, ['packages/model/src/value.ts']).map(plan => plan.workspace)).toEqual(['main', 'model']);
});

test('ambient declarations are included without edges; changed globals fall back to the workspace', () => {
  const f = fixture(); f.write('services/main/src/global.d.ts', 'declare const ambient: string;');
  expect(workerTypePlans(f.root, ['services/main/src/elsewhere.ts'])[0]!.files)
    .toEqual(['services/main/src/elsewhere.ts', 'services/main/src/global.d.ts']);
  f.write('services/main/src/value.ts', 'export {}; declare global { interface Thing { value: string } }');
  expect(workerTypePlans(f.root, ['services/main/src/value.ts'])[0]!.files).toBeUndefined();
});

test('a widely imported declaration and a set covering the project use the workspace task', () => {
  const f = fixture(); f.write('services/main/src/value.d.ts', 'export interface Value { name: string }');
  rmSync(join(f.root, 'services/main/src/value.ts'));
  expect(workerTypePlans(f.root, ['services/main/src/value.d.ts'])[0]!.files).toBeUndefined();
  expect(workerTypeCommands(f.root, ['services/main/src/public.ts', 'services/main/src/use.ts', 'services/main/src/value.d.ts', 'services/main/src/elsewhere.ts']))
    .toEqual([['task', 'main:typecheck']]);
});

test('index edges can provide selection and the graph is rebuilt after a source edit', () => {
  const f = fixture();
  expect(workerTypePlans(f.root, ['services/main/src/value.ts'], [{ source: 'services/main/src/use.ts',
    dependencies: [{ module: '@/value', resolved: 'services/main/src/value.ts', couldNotResolve: false, coreModule: false }] }])[0]!.files)
    .toContain('services/main/src/public.ts');
  f.write('services/main/src/elsewhere.ts', "export type { Value } from './value';");
  expect(workerTypePlans(f.root, ['services/main/src/value.ts'])[0]!.files).toBeUndefined();
  expect(workerTypePlans(f.root, ['docs/example.md'])).toEqual([]);
});

test('a global declaration without import edges selects its entire project', () => {
  const f = fixture(); f.write('services/main/src/global.d.ts', 'declare const ambient: string;');
  expect(workerTypePlans(f.root, ['services/main/src/global.d.ts'])[0]!.files).toBeUndefined();
});

test('the AppHost custom config and packages without named tasks retain full coverage', () => {
  const f = fixture();
  f.write('apphost/tsconfig.apphost.json', JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['*.mts'] }));
  f.write('apphost/apphost.mts', 'export {};');
  expect(workerTypeCommands(f.root, ['apphost/apphost.mts'])).toEqual([['task', 'apphost:typecheck']]);
  f.write('packages/zone-sdk/tsconfig.json', '{}');
  f.write('packages/zone-sdk/index.ts', 'export {};');
  expect(workerTypeCommands(f.root, ['packages/zone-sdk/package.json']))
    .toEqual([['task', 'goal:type-files', '--', '--project', 'packages/zone-sdk/tsconfig.json']]);
});

test('the selected checker rejects a broken dependent while leaving unrelated sources out', async () => {
  const f = fixture();
  f.write('services/main/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext',
    moduleResolution: 'Bundler', strict: true, types: [], noEmit: true, skipLibCheck: true, paths: { '@/*': ['./src/*'] } }, include: ['src/*.ts'] }));
  f.write('services/main/src/use.ts', "import type { Value } from '@/value'; const value: Value = { name: 123 }; export { value };");
  f.write('services/main/src/elsewhere.ts', 'const unrelated: string = 123; export { unrelated };');
  const plan = workerTypePlans(f.root, ['services/main/src/value.ts'])[0]!;
  f.write('Taskfile.yml', 'version: "3"\ntasks:\n  selected:\n    cmds:\n      - bun check --no-pretty --threads 8 {{.CLI_ARGS}}\n');
  const selected = Bun.spawn(['task', '--dir', f.root, 'selected', '--', '--project', plan.project, ...plan.files!], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(selected.stdout).text() + await new Response(selected.stderr).text();
  expect(await selected.exited).not.toBe(0);
  expect(output).toContain('use.ts'); expect(output).not.toContain('elsewhere.ts');
}, 30_000);

test('the Rust index adapter supplies type-only edges and unresolved imports retain compiler resolution', () => {
  const f = fixture();
  f.write('scripts/lib/repo-index.ts', `export function repositoryIndex() { return { files: {
    'services/main/src/use.ts': { imports: [{ source: '@/value', resolved: null, typeOnly: true }] }
  } }; }`);
  expect(workerTypeCommands(f.root, ['services/main/src/value.ts'])[0])
    .toEqual(['task', 'goal:type-files', '--', '--project', 'services/main/tsconfig.json',
      'services/main/src/public.ts', 'services/main/src/use.ts', 'services/main/src/value.ts']);
});
