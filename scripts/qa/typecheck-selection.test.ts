import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planAffected, TYPECHECK_WORKSPACES, typecheckWorkspaces } from './affected.ts';
import { workerCheck } from '../goal/check.ts';
import { preMergeTypecheckGate } from '../goal/typecheck-gate.ts';

const scratch = join(import.meta.dir, '../../.temp/typecheck-selection-tests');
const fixtures: string[] = [];

function project() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'project-'));
  fixtures.push(root);
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('scripts/tsconfig.json', JSON.stringify({ compilerOptions: { noLib: true, types: [], allowImportingTsExtensions: true },
    include: ['**/*.ts'], exclude: ['datasets/**'] }));
  write('scripts/entry.ts', "import type { Persona } from '../tests/anywhere/persona.ts';\nexport type Worker = Persona;\n");
  write('tests/anywhere/persona.ts', "export type { Persona } from './detail.ts';\n");
  write('tests/anywhere/detail.ts', 'export interface Persona { name: string }\n');
  write('tests/qa/support/unread.ts', 'export {};\n');
  write('tests/unread.test.ts', 'export {};\n');
  write('scripts/datasets/import.ts', "import '../tests-only.ts';\n");
  write('scripts/tests-only.ts', 'export {};\n');
  return { root, write };
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('shared QA support read by scripts selects the scripts type check', () => {
  expect(typecheckWorkspaces(['tests/qa/support/personas.ts'])).toEqual(['scripts']);
}, 30_000);

test('direct and transitive type imports select scripts regardless of their test directory', () => {
  const p = project();
  expect(typecheckWorkspaces(['tests/anywhere/persona.ts', 'tests/anywhere/detail.ts'], p.root)).toEqual(['scripts']);
});

test('unimported tests and support files do not select scripts', () => {
  const p = project();
  expect(typecheckWorkspaces(['tests/unread.test.ts', 'tests/qa/support/unread.ts'], p.root)).toEqual([]);
});

test('selection rereads imports when the project changes', () => {
  const p = project();
  expect(typecheckWorkspaces(['tests/unread.test.ts'], p.root)).toEqual([]);
  p.write('scripts/entry.ts', "import '../tests/unread.test.ts';\n");
  expect(typecheckWorkspaces(['tests/unread.test.ts'], p.root)).toEqual(['scripts']);
});

test('existing workspace ownership, longer dataset roots, configs and non-source exclusions stay intact', () => {
  expect(typecheckWorkspaces(['services/main/tests/list.test.ts', 'services/main/src/app.ts', 'apps/web/src/a.tsx']))
    .toEqual(['main', 'web']);
  expect(typecheckWorkspaces(['packages/model/package.json', 'scripts/observability/probe.ts', 'apphost/apphost.mts']))
    .toEqual(['model', 'scripts', 'apphost']);
  expect(typecheckWorkspaces(['scripts/datasets/cli.ts', 'scripts/dev/cli.ts'])).toEqual(['dataset', 'scripts']);
  expect(typecheckWorkspaces(['scripts/datasets/cli.ts'])).toEqual(['dataset']);
  expect(typecheckWorkspaces(['scripts/goal/goalctl.ts', 'scripts/tsconfig.json'])).toEqual(['scripts']);
  expect(typecheckWorkspaces(['docs/goals/README.md', 'services/main/migrations/001.sql', 'tests/qa/support/README.md'])).toEqual([]);
  for (const [workspace, roots] of TYPECHECK_WORKSPACES) {
    expect(typecheckWorkspaces([`${roots[0]}example.ts`])).toEqual([workspace]);
  }
});

test('worker check selects the changed worktree project for an imported support file', async () => {
  const p = project();
  const commands: string[][] = [];
  const result = await workerCheck({ cwd: p.root, changed: ['tests/anywhere/detail.ts'], only: ['types'], print: () => {},
    runner: async command => { commands.push([...command]); return { code: 0, output: '' }; },
    slotOptions: { slotDirectory: join(p.root, '.temp/slots'), slots: 1, reap: () => {}, announce: () => {} },
  });
  expect(result.code).toBe(0);
  expect(commands).toEqual([['task', 'scripts:typecheck']]);
});

test('affected planning selects the scripts task from the worktree import graph', () => {
  const p = project();
  const plan = planAffected({ base: 'base', changed: ['tests/anywhere/detail.ts', 'tests/unread.test.ts'],
    graph: [], sources: new Map(), exists: () => true, typecheckRoot: p.root });
  expect(plan.tasks).toEqual([{ task: 'scripts:typecheck', because: 'tests/anywhere/detail.ts: script type check' }]);
});

test('the merge gate selects scripts from the branch imports before landing', async () => {
  const p = project();
  p.write('.temp/typechecks.txt', '');
  p.write('Taskfile.yml', 'version: "3"\ntasks:\n  scripts:typecheck:\n    cmds:\n      - echo scripts:typecheck >> .temp/typechecks.txt\n');
  const refusal = await preMergeTypecheckGate(p.root, p.root, 'unused-on-a-passing-branch', ['tests/anywhere/detail.ts'], false);
  expect(refusal).toBeUndefined();
  expect(readFileSync(join(p.root, '.temp/typechecks.txt'), 'utf8')).toBe('scripts:typecheck\n');
});
