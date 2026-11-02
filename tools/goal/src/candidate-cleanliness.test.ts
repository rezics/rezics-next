import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { MergeTrain, type CandidateGitRunner } from './merge-train.ts';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { git } from './merge.ts';
import { markdown, mergeTrainHarness } from './test-support.ts';

function candidate() {
  const h = mergeTrainHarness();
  const task = h.branch('candidate', 'candidate.txt', 'candidate bytes\n');
  const expected = git(task.worktree, 'rev-parse', 'HEAD');
  const mainBefore = git(h.main, 'rev-parse', 'main');
  h.queue.enqueue(task);
  return { h, task, expected, mainBefore };
}

async function train(
  h: ReturnType<typeof mergeTrainHarness>,
  runGate: (cwd: string) => Promise<void> | void,
  runCandidateGit?: CandidateGitRunner,
) {
  await new MergeTrain({
    ...h.options,
    ...(runCandidateGit ? { runCandidateGit } : {}),
    runGate: async (_command, cwd) => {
      await runGate(cwd);
      return { passed: true, output: '', timedOut: false };
    },
  }).run();
  return h.outcomes[0]!;
}

test('a clean real candidate passes unchanged checks, publishes its commit, and excludes check artifacts', async () => {
  const s = candidate();
  let checkedHead = '';
  let checkedBytes = '';
  try {
    const outcome = await train(s.h, (cwd) => {
      checkedHead = git(cwd, 'rev-parse', 'HEAD');
      checkedBytes = readFileSync(join(cwd, 'candidate.txt'), 'utf8');
      writeFileSync(join(cwd, 'incidental-check-output.txt'), 'not committed\n');
      expect(git(cwd, 'rev-parse', 'HEAD')).toBe(checkedHead);
      expect(readFileSync(join(cwd, 'candidate.txt'), 'utf8')).toBe(checkedBytes);
    });

    expect(outcome.passed).toBe(true);
    expect(checkedHead).toBe(s.expected);
    expect(checkedBytes).toBe('candidate bytes\n');
    expect(git(s.h.main, 'rev-parse', 'main')).toBe(s.expected);
    expect(readFileSync(join(s.h.main, 'candidate.txt'), 'utf8')).toBe('candidate bytes\n');
    expect(existsSync(join(s.h.main, 'incidental-check-output.txt'))).toBe(false);
    expect(readFileSync(outcome.logPath, 'utf8')).toContain(
      `Candidate integrity verified phase=acceptance HEAD=${s.expected}`,
    );
  } finally {
    s.h.close();
  }
});

test('the real control-plane check boundary records a dirty candidate before baseline comparison or publication', async () => {
  const h = mergeTrainHarness();
  const file = 'tools/goal/src/candidate-fixture.ts';
  const task = h.branch('control-plane-candidate', file, 'candidate bytes\n');
  const expected = git(task.worktree, 'rev-parse', 'HEAD');
  const mainBefore = git(h.main, 'rev-parse', 'main');
  const brief = parseBrief(
    markdown.replace('goal: fixture', 'goal: control-plane\ntarget: main'),
    readRiskOwnership(join(import.meta.dir, '../risk-areas.json')),
  );
  const commands: string[][] = [];
  try {
    git(h.main, 'branch', 'dev', 'main');
    h.store.createTask(
      brief,
      { briefPath: join(h.path, 'control-plane.md'), worktree: task.worktree, branch: task.branch, base: mainBefore },
      'implementation',
      task.taskId,
    );
    h.queue.enqueue(task);

    await new MergeTrain({
      ...h.options,
      integrationBranch: 'dev',
      affectedTests: [],
      runGate: async (command, cwd) => {
        commands.push([...command]);
        if (command.at(-1) === 'tools/goal/src') writeFileSync(join(cwd, file), 'mutated by control-plane suite\n');
        return { passed: true, output: '', timedOut: false };
      },
    }).run();

    const outcome = h.outcomes[0]!;
    const log = readFileSync(outcome.logPath, 'utf8');
    expect(outcome.passed).toBe(false);
    expect(outcome.firstFailure?.assertion).toContain(
      'Candidate integrity violation phase=control-plane typecheck and test suite',
    );
    expect(log).toContain(`expected HEAD=${expected}`);
    expect(log).toContain(`unstaged paths: ["${file}"]`);
    expect(commands).toContainEqual(['bun', 'test', '--timeout', '30000', 'tools/goal/src']);
    expect(git(h.main, 'rev-parse', 'main')).toBe(mainBefore);
    expect(readFileSync(join(task.worktree, file), 'utf8')).toBe('candidate bytes\n');
  } finally {
    h.close();
  }
});

test('a tracked unstaged check mutation is diagnosed with its path and blocks publication', async () => {
  const s = candidate();
  try {
    const outcome = await train(s.h, (cwd) => writeFileSync(join(cwd, 'candidate.txt'), 'mutated bytes\n'));
    const log = readFileSync(outcome.logPath, 'utf8');

    expect(outcome.passed).toBe(false);
    expect(outcome.firstFailure?.assertion).toContain('Candidate integrity violation phase=acceptance');
    expect(outcome.firstFailure?.assertion).toContain('tracked working-tree changes detected');
    expect(log).toContain(`expected HEAD=${s.expected}`);
    expect(log).toContain('unstaged paths: ["candidate.txt"]');
    expect(log).toContain('safe patch (changed line contents redacted)');
    expect(log).toContain('-[content redacted]');
    expect(log).toContain('+[content redacted]');
    expect(git(s.h.main, 'rev-parse', 'main')).toBe(s.mainBefore);
    expect(readFileSync(join(s.task.worktree, 'candidate.txt'), 'utf8')).toBe('candidate bytes\n');
    expect(readFileSync(join(s.h.main, 'base'), 'utf8')).toBe('base\n');
    expect(existsSync(join(s.h.main, 'candidate.txt'))).toBe(false);
  } finally {
    s.h.close();
  }
});

test('a staged check mutation is diagnosed separately and blocks publication', async () => {
  const s = candidate();
  try {
    const outcome = await train(s.h, (cwd) => {
      writeFileSync(join(cwd, 'candidate.txt'), 'staged mutation\n');
      git(cwd, 'add', '--', 'candidate.txt');
    });
    const log = readFileSync(outcome.logPath, 'utf8');

    expect(outcome.passed).toBe(false);
    expect(outcome.firstFailure?.assertion).toContain('Candidate integrity violation phase=acceptance');
    expect(log).toContain('staged paths vs observed HEAD: ["candidate.txt"]');
    expect(log).toContain('unstaged paths: []');
    expect(git(s.h.main, 'rev-parse', 'main')).toBe(s.mainBefore);
    expect(readFileSync(join(s.task.worktree, 'candidate.txt'), 'utf8')).toBe('candidate bytes\n');
  } finally {
    s.h.close();
  }
});

test('a check that changes candidate HEAD records committed paths and blocks publication', async () => {
  const s = candidate();
  try {
    const outcome = await train(s.h, (cwd) => {
      writeFileSync(join(cwd, 'check-commit.txt'), 'committed by check\n');
      git(cwd, 'add', '--', 'check-commit.txt');
      git(cwd, 'commit', '-m', 'Unexpected check commit');
    });
    const log = readFileSync(outcome.logPath, 'utf8');

    expect(outcome.passed).toBe(false);
    expect(outcome.firstFailure?.assertion).toContain('Candidate integrity violation phase=acceptance: HEAD changed');
    expect(log).toContain(`expected HEAD=${s.expected}`);
    expect(log).toContain('committed paths vs expected HEAD: ["check-commit.txt"]');
    expect(git(s.h.main, 'rev-parse', 'main')).toBe(s.mainBefore);
    expect(readFileSync(join(s.task.worktree, 'candidate.txt'), 'utf8')).toBe('candidate bytes\n');
  } finally {
    s.h.close();
  }
});

test('a Git execution failure records the exit and error and blocks publication', async () => {
  const s = candidate();
  try {
    const runCandidateGit: CandidateGitRunner = (_cwd, args) =>
      args.join(' ') === 'diff --quiet HEAD --'
        ? { status: 29, signal: null, stdout: '', stderr: 'injected postcheck failure' }
        : undefined;
    const outcome = await train(s.h, () => {}, runCandidateGit);
    const log = readFileSync(outcome.logPath, 'utf8');

    expect(outcome.passed).toBe(false);
    expect(outcome.firstFailure?.assertion).toContain('Candidate Git infrastructure failure phase=acceptance');
    expect(outcome.firstFailure?.assertion).toContain('exit=29');
    expect(log).toContain('git diff --quiet HEAD --: exit=29');
    expect(log).toContain('stderr="injected postcheck failure"');
    expect(git(s.h.main, 'rev-parse', 'main')).toBe(s.mainBefore);
  } finally {
    s.h.close();
  }
});
