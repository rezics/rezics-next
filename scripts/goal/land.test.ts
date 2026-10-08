import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { findingsFromText, handoffResult, land, reviewBranch, reviewEngine } from './land.ts';
import { parseBrief, validateBrief, type Ledger, type Task } from './goalctl.ts';

function repo(options: { result?: string; auto?: boolean; files?: Record<string, string>; paths?: string[] } = {}) {
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
  for (const [path, content] of Object.entries(options.files ?? {})) write(path, content);
  const paths = options.paths ?? ['value.ts', 'value.test.ts'];
  const brief = 'docs/goals/alpha/tasks/G-001.md';
  write(brief, `---\nid: G-001\ntitle: Deliver value\nengine: codex\neffort: high\npaths: [${paths.join(', ')}]\n${options.auto ? 'land: auto\n' : ''}---\nDeliver value.\n`);
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
    cases: [], paths, migrations: [], shared: [], depends: [],
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
if (args[0] === 'install') process.exit(0);
if (args.includes('--list')) {
  console.log('Affected since HEAD: fixture');
  if (process.env.GOAL_TEST_PLAN) console.log(readFileSync(process.env.GOAL_TEST_PLAN, 'utf8'));
  if (process.env.GATE_FAILURE || process.env.DRIFT_PHASE === 'gate') console.log('  unit: value.test.ts');
  process.exit(0);
}
if (process.env.GOAL_TEST_LOG) appendFileSync(process.env.GOAL_TEST_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
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

  test('the review engine comes from the override, then the program file, then codex', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-review-engine-'));
    const file = join(directory, 'review-engine');
    try {
      expect(reviewEngine({}, file)).toBe('codex');
      writeFileSync(file, 'sonnet\n');
      expect(reviewEngine({}, file)).toBe('sonnet');
      expect(reviewEngine({ GOAL_REVIEW_ENGINE: 'codex-1' }, file)).toBe('codex-1');
      expect(() => reviewEngine({ GOAL_REVIEW_ENGINE: 'grok' }, file)).toThrow('GOAL_REVIEW_ENGINE');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('a reviewer reply may wrap its findings object in prose or a fence', () => {
    expect(findingsFromText('{"findings":[]}')).toEqual({ findings: [] });
    expect(findingsFromText('Review done.\n```json\n{"findings":["a P1"]}\n```')).toEqual({ findings: ['a P1'] });
    expect(() => findingsFromText('no object here')).toThrow();
  });

  test('the sonnet reviewer gets the diff in its prompt and its findings fail closed', async () => {
    const r = repo();
    const bin = mkdtempSync(join(tmpdir(), 'goal-review-bin-'));
    const directory = mkdtempSync(join(tmpdir(), 'goal-review-'));
    const path = process.env.PATH;
    try {
      writeFileSync(join(r.worktree, 'reviewed.txt'), 'reviewed change\n');
      r.git(r.worktree, 'add', 'reviewed.txt');
      r.git(r.worktree, 'commit', '-qm', 'Reviewed change');
      const head = r.git(r.worktree, 'rev-parse', 'HEAD').trim();
      const base = r.git(r.worktree, 'rev-parse', 'HEAD~1').trim();
      // The stub copies its stdin aside and answers like `claude -p --output-format json`.
      const reply = join(bin, 'reply.json');
      writeFileSync(reply, JSON.stringify({ is_error: false, result: 'Done. {"findings":["P1 stub"]}' }));
      writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > "${directory}/stdin.txt"\ncat "${reply}"\n`);
      chmodSync(join(bin, 'claude'), 0o755);
      process.env.PATH = `${bin}:${path}`;
      const findings = await reviewBranch({ directory, worktree: r.worktree, brief: 'brief', handoff: 'RESULT: done',
        base, head }, 'sonnet');
      expect(findings).toEqual(['P1 stub']);
      expect(readFileSync(join(directory, 'stdin.txt'), 'utf8')).toContain('+reviewed change');
      // A schema-validated object from the CLI wins over the text.
      writeFileSync(reply, JSON.stringify({ is_error: false, result: 'prose', structured_output: { findings: ['P2 structured'] } }));
      expect(await reviewBranch({ directory, worktree: r.worktree, brief: 'brief', handoff: 'RESULT: done',
        base, head }, 'sonnet')).toEqual(['P2 structured']);
      writeFileSync(reply, JSON.stringify({ is_error: true, result: 'limit' }));
      await expect(reviewBranch({ directory, worktree: r.worktree, brief: 'brief', handoff: 'RESULT: done',
        base, head }, 'sonnet')).rejects.toThrow('reported an error');
    } finally {
      process.env.PATH = path;
      r.cleanup(); rmSync(bin, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test('land accepts an unclaimed owner change and reports it after merge', () => {
    const r = repo();
    const file = 'docs/owner-note.md';
    try {
      mkdirSync(join(r.worktree, 'docs'), { recursive: true });
      writeFileSync(join(r.worktree, file), 'Owner change.\n');
      r.git(r.worktree, 'add', file);
      r.git(r.worktree, 'commit', '-qm', 'Add owner change');
      const result = r.run();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`permitted unclaimed files:\n  ${file}`);
      expect(r.git(r.dir, 'show', `main:${file}`)).toContain('Owner change');
      expect(r.ledger().tasks[r.task.id]!.state).toBe('verified');
    } finally { r.cleanup(); }
  }, 30_000);

  test('land refuses an out-of-claim file claimed by another live task', () => {
    const r = repo();
    const file = 'docs/owner-note.md';
    try {
      mkdirSync(join(r.worktree, 'docs'), { recursive: true });
      writeFileSync(join(r.worktree, file), 'Owner change.\n');
      r.git(r.worktree, 'add', file);
      r.git(r.worktree, 'commit', '-qm', 'Add owner change');
      const ledger = r.ledger();
      ledger.tasks['G-002'] = { ...r.task, id: 'G-002', title: 'Another task', paths: [file], state: 'exited',
        worktree: join(r.dir, '.temp/worktrees/another'), branch: 'goal/another' };
      r.save(ledger);
      const result = r.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('claimed by another task');
      expect(result.stderr).toContain(file);
      expect(existsSync(r.log)).toBe(false);
      expect(r.git(r.dir, 'rev-parse', 'main')).toBe(r.base);
    } finally { r.cleanup(); }
  }, 30_000);

  test('merge still refuses an unclaimed out-of-claim file without --allow-scope', () => {
    const r = repo();
    const file = 'docs/owner-note.md';
    try {
      mkdirSync(join(r.worktree, 'docs'), { recursive: true });
      writeFileSync(join(r.worktree, file), 'Owner change.\n');
      r.git(r.worktree, 'add', file);
      r.git(r.worktree, 'commit', '-qm', 'Add owner change');
      const result = r.run('merge');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('changed files outside its claim');
      expect(r.git(r.dir, 'rev-parse', 'main')).toBe(r.base);
    } finally { r.cleanup(); }
  }, 30_000);

  test('a timeout on main is retried alone and its passing result makes the branch failure introduced', () => {
    const file = 'timeout-main.test.ts';
    const baseline = `import { expect, setDefaultTimeout, test } from 'bun:test';\n`
      + `import { readFileSync } from 'node:fs';\nsetDefaultTimeout(500);\n`
      + `test('main timeout is isolated on retry', async () => {\n`
      + `  const runs = readFileSync(process.env.GOAL_TEST_LOG!, 'utf8').trim().split('\\n').length;\n`
      + `  if (runs === 3) await Bun.sleep(1_000);\n  expect(true).toBe(true);\n});\n`;
    const r = repo({ files: { [file]: baseline }, paths: ['value.ts', file] });
    try {
      writeFileSync(join(r.worktree, file), `import { expect, test } from 'bun:test';\n`
        + `test('branch failure', () => expect(false).toBe(true));\n`);
      r.git(r.worktree, 'add', file);
      r.git(r.worktree, 'commit', '-qm', 'Change unit behaviour');
      const plan = join(r.dir, '.temp/unit-plan');
      const log = join(r.dir, '.temp/unit-log');
      writeFileSync(plan, `  unit: ${file}\n`);
      const result = r.run('land', { GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log, GOAL_UNIT_GATE_SHARDS: '1' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('introduced unit failures');
      expect(result.stdout).toContain(`${file} timed out on main; rerunning alone`);
      const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { cwd: string; args: string[] });
      // A shard line that follows an alone announcement is that isolated rerun. The confirm of the failing
      // set stays one shard, then the branch-only classification runs the file alone on each side.
      const modes: ('sharded' | 'alone')[] = [];
      let announcedAlone = false;
      for (const line of result.stdout.split('\n')) {
        if (/rerunning alone|rerun alone on /.test(line)) announcedAlone = true;
        else if (/ file\(s\) in \d+ shard\(s\)/.test(line)) {
          modes.push(announcedAlone ? 'alone' : 'sharded');
          announcedAlone = false;
        }
      }
      const baseline = runs.find(run => run.cwd !== r.worktree)?.cwd;
      expect(runs.map((run, index) => ({
        side: run.cwd === r.worktree ? 'affected' : run.cwd === baseline ? 'main' : run.cwd,
        mode: modes[index],
        files: run.args.filter(arg => arg.endsWith('.test.ts')).map(arg => arg.slice(2)),
      }))).toEqual([
        { side: 'affected', mode: 'sharded', files: [file] },
        { side: 'affected', mode: 'sharded', files: [file] },
        { side: 'main', mode: 'sharded', files: [file] },
        { side: 'main', mode: 'alone', files: [file] },
        { side: 'affected', mode: 'alone', files: [file] },
        { side: 'main', mode: 'alone', files: [file] },
      ]);
      expect(r.ledger().tasks[r.task.id]!.state).toBe('conflict');
      expect(r.git(r.dir, 'rev-parse', 'main')).toBe(r.base);
    } finally { r.cleanup(); }
  }, 30_000);

  test('lands and reports out-of-claim files that no live task claims', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-land-scope-'));
    const runDir = join(directory, 'runs', 'G-001');
    mkdirSync(runDir, { recursive: true });
    const permitted = ['docs/owner-note.md', 'scripts/helper.ts'];
    const reports: string[] = [];
    const previousLog = console.log;
    console.log = (...values: unknown[]) => reports.push(values.join(' '));
    try {
      let reviewed: string[] | undefined;
      let merged: string[] | undefined;
      await land({ id: 'G-001', worktree: directory, base: 'base', head: 'head', brief: 'brief',
        handoff: 'RESULT: done\n', runDir,
        scope: async () => ({ outOfClaim: [...permitted, permitted[0]!], claimedByOthers: [] }),
        review: async request => { reviewed = request.permittedFiles; return []; },
        merge: async files => { merged = files; }, close: async () => {} });
      expect(reviewed).toEqual(permitted);
      expect(merged).toEqual(permitted);
      expect(reports.join('\n')).toContain(`G-001: permitted unclaimed files:\n  ${permitted.join('\n  ')}`);
    } finally {
      console.log = previousLog;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('refuses an out-of-claim file claimed by another live task', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-land-scope-'));
    const runDir = join(directory, 'runs', 'G-001');
    mkdirSync(runDir, { recursive: true });
    let reviewed = false;
    let merged = false;
    try {
      await expect(land({ id: 'G-001', worktree: directory, base: 'base', head: 'head', brief: 'brief',
        handoff: 'RESULT: done\n', runDir,
        scope: async () => ({ outOfClaim: ['scripts/helper.ts'], claimedByOthers: ['scripts/helper.ts'] }),
        review: async () => { reviewed = true; return []; },
        merge: async () => { merged = true; }, close: async () => {} })).rejects.toThrow('claimed by another task');
      expect(reviewed).toBe(false);
      expect(merged).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
