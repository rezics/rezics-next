import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { expect, test } from 'bun:test';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { mergeTrainHarness } from './test-support.ts';

function candidate() {
  const h = mergeTrainHarness();
  const task = h.branch('candidate', 'candidate.txt', 'candidate bytes\n');
  const expected = git(task.worktree, 'rev-parse', 'HEAD');
  const mainBefore = git(h.main, 'rev-parse', 'main');
  h.queue.enqueue(task);
  return { h, task, expected, mainBefore };
}

async function train(h: ReturnType<typeof mergeTrainHarness>, runGate: (cwd: string) => Promise<void> | void) {
  await new MergeTrain({
    ...h.options,
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
    expect(readFileSync(join(s.h.main, 'candidate.txt'), 'utf8')).toBe('base\n');
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
  const originalPath = process.env.PATH;
  try {
    const realGit = (originalPath ?? '').split(delimiter).map((directory) => join(directory, 'git')).find(existsSync);
    if (!realGit) throw new Error('Could not locate the real git executable for the failure fixture');
    const fakeBin = join(s.h.path, 'fake-bin');
    mkdirSync(fakeBin, { recursive: true });
    const fakeGit = join(fakeBin, 'git');
    const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      fakeGit,
      `#!/bin/sh\nif [ "$1" = diff ] && [ "$2" = --quiet ] && [ "$3" = HEAD ] && [ "$4" = -- ]; then\n  echo 'injected postcheck failure' >&2\n  exit 29\nfi\nexec ${quotedGit} "$@"\n`,
    );
    chmodSync(fakeGit, 0o755);
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`;

    const outcome = await train(s.h, () => {});
    const log = readFileSync(outcome.logPath, 'utf8');

    expect(outcome.passed).toBe(false);
    expect(outcome.firstFailure?.assertion).toContain('Candidate Git infrastructure failure phase=acceptance');
    expect(outcome.firstFailure?.assertion).toContain('exit=29');
    expect(log).toContain('git diff --quiet HEAD --: exit=29');
    expect(log).toContain('stderr="injected postcheck failure"');
    expect(git(s.h.main, 'rev-parse', 'main')).toBe(s.mainBefore);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    s.h.close();
  }
});
