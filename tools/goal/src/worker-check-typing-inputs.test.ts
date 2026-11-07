import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beginTypingInputReceipt, readTypingInputReceipt, typingInputsMatch } from './worker-check-typing-inputs.ts';
import {
  admitWorkerCheckHostRun,
  recordWorkerCheckTypingInputs,
  settleWorkerCheckHostBudget,
  workerCheckHostTypingSettlement,
} from './worker-check-budget.ts';

const roots: string[] = [];
const physical = 'a1a1a1a1-1111-4111-8111-111111111111';
const command = ['bun', 'scripts/typecheck.ts'];
const environment = {
  REZICS_TYPING_INPUTS_PHYSICAL: physical,
  REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(command)).toString('base64'),
};
function write(root: string, file: string, value: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), value);
}
function fixture() {
  const parent = join(import.meta.dir, '../../../.temp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'typing-inputs-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'typing@example.invalid');
  git('config', 'user.name', 'Typing');
  write(root, '.gitignore', '.temp/\n**/generated/\napps/web/src/paraglide/\n');
  write(root, 'apps/web/tsconfig.json', '{"include":["src/**/*.ts"]}');
  write(root, 'apps/web/src/placeholder.ts', 'export const ready = true;');
  write(root, 'package.json', '{"name":"fixture"}');
  write(root, 'bun.lock', 'dependency identity');
  write(root, 'tsconfig.base.json', '{"compilerOptions":{"strict":true}}');
  write(
    root,
    'packages/fixture/package.json',
    JSON.stringify({ scripts: { typecheck: 'bun check --no-script -p tsconfig.json' } }),
  );
  write(
    root,
    'packages/fixture/tsconfig.json',
    JSON.stringify({
      extends: '../../tsconfig.base.json',
      include: ['src/**/*.ts', 'generated/**/*.d.ts'],
    }),
  );
  write(root, 'packages/fixture/src/source.ts', 'export const source = 1;');
  write(root, 'packages/fixture/src/query.sql', 'SELECT 1;');
  write(root, 'packages/fixture/generated/binding.d.ts', 'export type Entry = string;');
  write(root, 'packages/fixture/custom.input', 'custom generator input');
  write(root, 'docs/ledger.md', '# Evidence\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return root;
}
function passed(root: string) {
  const complete = beginTypingInputReceipt(root, environment, command)!;
  complete(0);
  return readTypingInputReceipt(root, physical, command)!;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('ledger-only edits keep configured typing evidence; imported Markdown stays a compiler input', () => {
  const root = fixture();
  const complete = beginTypingInputReceipt(root, environment, command)!;
  write(root, 'apps/web/src/paraglide/runtime.d.ts', 'export type Locale = string;');
  complete(0);
  const receipt = readTypingInputReceipt(root, physical, command)!;
  expect(receipt.sourceStable).toBe(true);
  expect(receipt.completed.profile).toBe('configured-typescript');
  expect(receipt.completed.excludedDocuments).toContain('docs/ledger.md');
  write(root, 'docs/ledger.md', '# Evidence\nAn observed pass.\n');
  expect(typingInputsMatch(root, receipt)).toBe(true);
  write(root, 'packages/fixture/src/source.ts', "import note from '../../../docs/ledger.md'; export default note;");
  const imported = passed(root);
  expect(imported.completed.excludedDocuments).not.toContain('docs/ledger.md');
  write(root, 'docs/ledger.md', '# Changed imported asset\n');
  expect(typingInputsMatch(root, imported)).toBe(false);
});

test('source, compiler configuration, generated declarations, SQL, dependencies and custom inputs invalidate evidence', () => {
  const root = fixture();
  const receipt = passed(root);
  expect(typingInputsMatch(root, receipt)).toBe(true);
  for (const file of [
    'packages/fixture/src/source.ts',
    'tsconfig.base.json',
    'packages/fixture/tsconfig.json',
    'packages/fixture/generated/binding.d.ts',
    'packages/fixture/src/query.sql',
    'bun.lock',
    'packages/fixture/package.json',
    'packages/fixture/custom.input',
  ]) {
    const original = readFileSync(join(root, file), 'utf8');
    const changed = file.endsWith('.json') ? original.replace(/}$/, ', "changed":true}') : `${original}\n/* change */`;
    write(root, file, changed);
    expect(typingInputsMatch(root, receipt), file).toBe(false);
    write(root, file, original);
  }
  write(root, 'packages/fixture/src/new-source.ts', 'export const added = 1;');
  expect(typingInputsMatch(root, receipt)).toBe(false);
});

test('unknown compiler commands retain documents and source edits during execution cannot stamp a false pass', () => {
  const root = fixture();
  write(root, 'packages/fixture/package.json', '{"scripts":{"typecheck":"bun custom-compiler.ts"}}');
  const custom = passed(root);
  expect(custom.completed.profile).toBe('conservative');
  write(root, 'docs/ledger.md', '# A custom compiler might read this\n');
  expect(typingInputsMatch(root, custom)).toBe(false);
  const complete = beginTypingInputReceipt(root, environment, command)!;
  write(root, 'packages/fixture/src/source.ts', 'export const changedWhileRunning = 1;');
  complete(0);
  const changed = readTypingInputReceipt(root, physical, command)!;
  expect(changed.sourceStable).toBe(false);
  expect(typingInputsMatch(root, changed)).toBe(false);
  expect(() => readTypingInputReceipt(root, physical, [...command, '--different'])).toThrow('binding');
});

test('budget settlement consumes invocation/physical-bound compiler evidence and makes missing closure explicit', () => {
  const root = fixture();
  const budget = join(root, '.temp/budget');
  const env = { ...environment, GOAL_WORKER_CHECK_BUDGET_DIR: budget, GOAL_WORKER_CHECK_BUDGET_STAMP: '1' };
  admitWorkerCheckHostRun({ directory: budget, worktree: root, limit: 2 });
  recordWorkerCheckTypingInputs(env, root, physical, command);
  passed(root);
  settleWorkerCheckHostBudget(env, 0, true, { argv: command, worktree: root, physicalRunId: physical });
  write(root, 'docs/ledger.md', '# Recorded evidence\n');
  expect(workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 })).toEqual({ ok: true });
  write(root, 'packages/fixture/src/query.sql', 'SELECT 2;');
  expect(workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 }).ok).toBe(false);
  // A later physical run cannot borrow the previous receipt or silently fall back to a legacy content stamp.
  const next = 'a2a2a2a2-2222-4222-8222-222222222222';
  recordWorkerCheckTypingInputs(env, root, next, command);
  settleWorkerCheckHostBudget(env, 0, true, { argv: command, worktree: root, physicalRunId: next });
  const missing = workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.result).toContain('Compiler input closure is unavailable');
});
