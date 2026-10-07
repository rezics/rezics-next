import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { handoffResult, reviewBranch } from './land.ts';
import { parseBrief, validateBrief, type Ledger, type Task } from './goalctl.ts';

function repo(options: { result?: string; auto?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'goal-land-'));
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'goal@example.invalid');
  git(dir, 'config', 'user.name', 'Goal tests');
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  write('.gitignore', '.temp/\n');
  write('scripts/goal/dedupe-imports.ts', readFileSync(join(import.meta.dir, 'dedupe-imports.ts'), 'utf8'));
  for (const file of ['app.ts', 'index.ts', 'routes/dependencies.ts']) write(`services/main/src/${file}`, 'export {};\n');
  const brief = 'docs/goals/alpha/tasks/G-001.md';
  write(brief, `---\nid: G-001\ntitle: Deliver value\nengine: codex\neffort: high\npaths: [value.ts, value.test.ts]\n${options.auto ? 'land: auto\n' : ''}---\nDeliver value.\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'Initial');
  const base = git(dir, 'rev-parse', 'HEAD');
  const worktree = join(dir, '.temp/worktrees/worker');
  git(dir, 'worktree', 'add', '-qb', 'goal/worker', worktree);
  writeFileSync(join(worktree, 'value.ts'), 'export const value = 1;\n');
  git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'Deliver value');
  const runDir = join(dir, '.temp/goal-orchestration/runs/G-001');
  mkdirSync(runDir, { recursive: true });
  const lastMessage = join(runDir, 'attempt-1.last.md');
  writeFileSync(lastMessage, `RESULT: ${options.result ?? 'done'}\nCASES: delivered\n`);
  const task: Task = { id: 'G-001', title: 'Deliver value', effort: 'high', engine: 'codex',
    cases: [], paths: ['value.ts', 'value.test.ts'], migrations: [], shared: [], depends: [],
    brief: join(dir, brief), worktree, branch: 'goal/worker', base, state: 'exited', goal: 'alpha',
    ...options.auto ? { land: 'auto' as const } : {},
    attempts: [{ n: 1, effort: 'high', engine: 'codex', pid: 0, session: '',
      output: join(runDir, 'attempt-1.json'), lastMessage, startedAt: new Date().toISOString() }] };
  const ledgerPath = join(dir, '.temp/goal-orchestration/ledger.json');
  writeFileSync(ledgerPath, JSON.stringify({ tasks: { [task.id]: task } }));
  const drift = `if (process.env.DRIFT_PHASE === phase) {
  const ledger = JSON.parse(readFileSync(process.env.LEDGER_PATH!, 'utf8'));
  const task = Object.values(ledger.tasks)[0] as any;
  if (process.env.DRIFT_KIND === 'brief') appendFileSync(task.brief, '\\nChanged outcome.\\n');
  if (process.env.DRIFT_KIND === 'handoff') writeFileSync(task.attempts.at(-1).lastMessage, 'RESULT: partial\\n');
  if (process.env.DRIFT_KIND === 'attempt') task.attempts.push({ ...task.attempts.at(-1), n: 2 });
  if (process.env.DRIFT_KIND === 'sharer') ledger.tasks['G-' + '002'] = { ...task, id: 'G-' + '002' };
  writeFileSync(process.env.LEDGER_PATH!, JSON.stringify(ledger));
}`;
  write('.temp/bin/codex', `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
await Bun.stdin.text();
appendFileSync(process.env.REVIEW_LOG!, JSON.stringify(args) + '\\n');
if (process.env.REVIEW_MUTATE === 'yes') {
  writeFileSync('value.ts', 'export const value = 99;\\n');
  Bun.spawnSync(['git', 'commit', '-qam', 'Changed during review']);
}
const phase = 'review';
${drift}
writeFileSync(args[args.indexOf('--output-last-message') + 1]!, process.env.REVIEW_JSON ?? '{"findings":[]}');
process.exit(Number(process.env.REVIEW_EXIT ?? 0));
`);
  write('.temp/bin/task', `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--list')) { console.log('Affected since HEAD: fixture'); if (process.env.GATE_FAILURE || process.env.DRIFT_PHASE === 'gate') console.log('  unit: value.test.ts'); process.exit(0); }
const phase = 'gate';
${drift}
const child = Bun.spawn(['bun', 'test', ...args.slice(2)], { stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
`);
  for (const binary of ['codex', 'task']) chmodSync(join(dir, '.temp/bin', binary), 0o755);
  const log = join(dir, '.temp/reviewer.log');
  const run = (command = 'land', overrides: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_ID: 'alpha', REVIEW_LOG: log, LEDGER_PATH: ledgerPath,
      PATH: `${join(dir, '.temp/bin')}:${process.env.PATH}`, ...overrides };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
    return spawnSync('bun', [join(import.meta.dir, 'goalctl.ts'), command, task.id],
      { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
  };
  return { dir, worktree, runDir, log, base, task, run, git,
    ledger: () => JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger,
    save: (ledger: Ledger) => writeFileSync(ledgerPath, JSON.stringify(ledger)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('Goal landing', () => {
  test('auto landing is an explicit validated brief option', () => {
    const brief = '---\nid: G-001\ntitle: t\nengine: codex\neffort: high\nland: auto\n---\n';
    expect(parseBrief(brief).land).toBe('auto');
    expect(validateBrief(parseBrief(brief))).toEqual([]);
    expect(validateBrief(parseBrief(brief.replace('auto', 'yes')))).toContain('land must be auto: yes');
    expect(parseBrief(brief.replace('land: auto\n', '')).land).toBeUndefined();
  });

  test('requires exactly one complete done result', () => {
    expect(handoffResult('RESULT: done\r\nCASES: ok')).toBe('done');
    expect(handoffResult('RESULT: done\nRESULT: partial')).toBeUndefined();
    expect(handoffResult('RESULT: done\nRESULT: partial because unfinished')).toBeUndefined();
    expect(handoffResult('RESULT:\n done')).toBeUndefined();
    expect(handoffResult('RESULT: done but unfinished')).toBeUndefined();
    expect(handoffResult('no handoff')).toBeUndefined();
  });

  test('finds a result glued to the previous message segment', () => {
    expect(handoffResult("I'll restore the fixed file if that check left the old one in place.RESULT: done\nCASES: x")).toBe('done');
    expect(handoffResult('so it does not open the edition menu in a loop.RESULT: done\n\nCASES: x')).toBe('done');
    expect(handoffResult('Checked.RESULT: done\nRESULT: partial')).toBeUndefined();
    expect(handoffResult('the RESULT: done line comes later')).toBeUndefined();
  });

  test('reviews, merges, verifies and archives a done task', () => {
    const r = repo();
    try {
      const result = r.run();
      expect(result.stderr).toBe(''); expect(result.status).toBe(0);
      expect(result.stdout).toContain('landed and verified');
      expect(r.ledger().tasks[r.task.id]!.state).toBe('verified');
      expect(r.git(r.dir, 'show', 'main:value.ts')).toContain('value = 1');
      expect(existsSync(r.worktree)).toBe(false);
      const args = JSON.parse(readFileSync(r.log, 'utf8').trim()) as string[];
      expect(args.slice(0, 7)).toEqual(['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-s', 'read-only']);
      expect(r.git(r.dir, 'ls-tree', '-r', '--name-only', 'archive/goals')).toContain('handoffs/G-001.md');
      expect(readdirSync(r.runDir).some(name => name.startsWith('review-'))).toBe(true);
    } finally { r.cleanup(); }
  });

  test.each([
    ['review finding', { REVIEW_JSON: '{"findings":["Wrong behaviour in value.ts"]}' }, 'Wrong behaviour'],
    ['review failure', { REVIEW_EXIT: '1' }, 'reviewer exited 1'],
    ['malformed review', { REVIEW_JSON: '{}' }, 'invalid findings report'],
    ['empty finding', { REVIEW_JSON: '{"findings":[""]}' }, 'invalid findings report'],
    ['branch changed during review', { REVIEW_MUTATE: 'yes' }, 'review'],
  ])('%s stops and leaves the task open', (_name, env, reason) => {
    const r = repo();
    try {
      const result = r.run('land', env);
      expect(result.status).toBe(1); expect(result.stderr).toContain(reason);
      expect(r.ledger().tasks[r.task.id]!.state).toBe('exited');
      expect(existsSync(r.worktree)).toBe(true);
      expect(r.git(r.dir, 'rev-parse', 'main')).toBe(r.base);
    } finally { r.cleanup(); }
  });

  test('partial handoff stops before reviewing', () => {
    const r = repo({ result: 'partial' });
    try {
      const result = r.run();
      expect(result.status).toBe(1); expect(result.stderr).toContain('RESULT is partial');
      expect(r.ledger().tasks[r.task.id]!.state).toBe('exited');
      expect(existsSync(r.log)).toBe(false);
    } finally { r.cleanup(); }
  });

  test('auto wait prints a partial stop reason and leaves the task open', () => {
    const r = repo({ result: 'partial', auto: true });
    try {
      const result = r.run('wait');
      expect(result.status).toBe(1); expect(result.stderr).toContain('RESULT is partial');
      expect(r.ledger().tasks[r.task.id]!.state).toBe('exited');
      expect(existsSync(r.log)).toBe(false);
    } finally { r.cleanup(); }
  });

  test.each(['dirty', 'sharer', 'stopped', 'checkout'])('refuses an unsafe task before review: %s', kind => {
    const r = repo();
    try {
      if (kind === 'dirty') writeFileSync(join(r.worktree, 'value.ts'), 'unfinished');
      if (kind === 'checkout') r.git(r.worktree, 'checkout', '--detach', r.base);
      if (kind === 'sharer' || kind === 'stopped') {
        const ledger = r.ledger();
        if (kind === 'sharer') ledger.tasks['G-002'] = { ...r.task, id: 'G-002' };
        else ledger.tasks[r.task.id]!.state = 'stopped';
        r.save(ledger);
      }
      const result = r.run();
      expect(result.status).toBe(1); expect(result.stderr).toContain('land');
      expect(r.ledger().tasks[r.task.id]!.state).toBe(kind === 'stopped' ? 'stopped' : 'exited');
      expect(existsSync(r.log)).toBe(false);
    } finally { r.cleanup(); }
  });

  test('introduced unit failure refuses merge and leaves claims open', () => {
    const r = repo();
    try {
      writeFileSync(join(r.worktree, 'value.test.ts'), "import { test, expect } from 'bun:test'; test('value', () => expect(1).toBe(2));\n");
      r.git(r.worktree, 'add', '.'); r.git(r.worktree, 'commit', '-qm', 'Verify value');
      const result = r.run('land', { GATE_FAILURE: 'yes' });
      expect(result.status).toBe(1); expect(result.stderr).toContain('introduced unit failures');
      expect(r.ledger().tasks[r.task.id]!.state).toBe('conflict');
      expect(existsSync(r.worktree)).toBe(true);
      expect(r.git(r.dir, 'rev-parse', 'main')).toBe(r.base);
    } finally { r.cleanup(); }
  });

  for (const phase of ['review', 'gate']) {
    for (const kind of ['brief', 'handoff', 'attempt', 'sharer']) {
      test(`unchanged-head ${kind} drift during ${phase} leaves the task open`, () => {
        const r = repo();
        try {
          writeFileSync(join(r.worktree, 'value.test.ts'), "import { test } from 'bun:test'; test('value', () => {});\n");
          r.git(r.worktree, 'add', '.'); r.git(r.worktree, 'commit', '-qm', 'Verify value');
          const result = r.run('land', { DRIFT_PHASE: phase, DRIFT_KIND: kind });
          expect(result.status).toBe(1);
          expect(result.stderr).toContain(kind === 'sharer' && phase === 'gate' ? 'sharers changed' : kind === 'sharer' ? 'unreviewed sharer' : 'task or brief changed during review');
          expect(r.ledger().tasks[r.task.id]!.state).not.toBe('verified');
          expect(existsSync(r.worktree)).toBe(true);
          expect(r.git(r.dir, 'rev-parse', 'main')).toBe(r.base);
        } finally { r.cleanup(); }
      });
    }
  }

  test.each([true, false])('wait lands only an opted-in task: auto=%s', auto => {
    const r = repo({ auto });
    try {
      const result = r.run('wait');
      expect(result.stderr).toBe(''); expect(result.status).toBe(0);
      expect(r.ledger().tasks[r.task.id]!.state).toBe(auto ? 'verified' : 'exited');
      expect(existsSync(r.log)).toBe(auto);
    } finally { r.cleanup(); }
  }, 30_000);

  test('review launch failures reject normally and retain logs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-review-'));
    try {
      await expect(reviewBranch({ directory, worktree: join(directory, 'absent'),
        brief: 'brief', handoff: 'RESULT: done', base: 'base', head: 'head' })).rejects.toThrow();
      expect(existsSync(join(directory, 'stderr.log'))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
