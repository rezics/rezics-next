import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository } from './handover.test.ts';
import type { Task } from './types.ts';

type Repository = ReturnType<typeof repository>;

async function stopped(repo: Repository, result = 'partial'): Promise<Task> {
  expect(repo.run('dispatch', repo.brief()).status).toBe(0);
  await repo.record(repo.ledger().tasks['G-001']!);
  return settle(repo, result);
}

function settle(repo: Repository, result: string): Task {
  const ledger = repo.ledger();
  const task = ledger.tasks['G-001']!;
  task.state = 'exited';
  const attempt = task.attempts.at(-1)!;
  attempt.pid = 0;
  attempt.session = 'recording-session';
  writeFileSync(attempt.lastMessage!, `RESULT: ${result}\nNEXT: continue\n`);
  repo.save(ledger);
  rmSync(join(task.worktree, '.temp/record.json'));
  return task;
}

function advanceMain(repo: Repository, file = 'new-tool.ts', content = 'export const tool = true;\n'): string {
  writeFileSync(join(repo.dir, file), content);
  repo.git('add', file);
  repo.git('commit', '-qm', 'Main advances');
  return repo.git('rev-parse', 'HEAD');
}

function commitWork(repo: Repository, task: Task, file = 'claimed.ts', content = 'export const work = true;\n'): string {
  writeFileSync(join(task.worktree, file), content);
  repo.git('-C', task.worktree, 'add', file);
  repo.git('-C', task.worktree, 'commit', '-qm', 'Worker checkpoint');
  return repo.git('-C', task.worktree, 'rev-parse', 'HEAD');
}

function report(stdout: string): string {
  const lines = stdout.split('\n').filter(line => line.startsWith('G-001 worktree:'));
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

describe('resume worktree preparation', () => {
  test.each([false, true])('fast-forwards a branch with no commits before launch (fresh=%s)', async fresh => {
    const repo = repository();
    try {
      const task = await stopped(repo);
      const before = repo.git('-C', task.worktree, 'rev-parse', 'HEAD');
      advanceMain(repo);
      const main = advanceMain(repo, 'new-other.ts');
      const resumed = repo.run('resume', task.id, '-m', 'Use the new tooling.', ...fresh ? ['--fresh'] : []);
      expect(resumed.status).toBe(0);
      expect(report(resumed.stdout)).toBe(`G-001 worktree: ${before} -> ${main}; 2 commits behind main; fast-forwarded`);
      const recorded = await repo.record(repo.ledger().tasks[task.id]!);
      expect(recorded.head).toBe(main);
      expect(readFileSync(join(task.worktree, 'new-tool.ts'), 'utf8')).toContain('tool');
    } finally { repo.dispose(); }
  });

  test('rebases a clean branch with its own commit before launch', async () => {
    const repo = repository();
    try {
      const task = await stopped(repo);
      const before = commitWork(repo, task);
      const main = advanceMain(repo);
      const resumed = repo.run('resume', task.id, '-m', 'Continue the implementation.');
      expect(resumed.status).toBe(0);
      const recorded = await repo.record(repo.ledger().tasks[task.id]!);
      expect(recorded.head).not.toBe(before);
      expect(repo.git('-C', task.worktree, 'rev-parse', 'HEAD^')).toBe(main);
      expect(repo.git('-C', task.worktree, 'rev-list', '--count', 'main..HEAD')).toBe('1');
      expect(report(resumed.stdout)).toBe(`G-001 worktree: ${before} -> ${recorded.head}; 1 commits behind main; rebased`);
      expect(readFileSync(join(task.worktree, 'claimed.ts'), 'utf8')).toContain('work');
    } finally { repo.dispose(); }
  });

  test.each([false, true])('undoes a conflicting rebase and names the files in output and prompt (fresh=%s)', async fresh => {
    const repo = repository();
    try {
      const task = await stopped(repo);
      const before = commitWork(repo, task);
      advanceMain(repo, 'claimed.ts', 'export const main = true;\n');
      const resumed = repo.run('resume', task.id, '-m', 'Continue.', ...fresh ? ['--fresh'] : []);
      expect(resumed.status).toBe(0);
      const recorded = await repo.record(repo.ledger().tasks[task.id]!);
      const line = report(resumed.stdout);
      expect(line).toBe(`G-001 worktree: ${before} -> ${before}; 1 commits behind main; rebase undone; conflicts: claimed.ts`);
      expect(recorded.prompt).toContain(line);
      expect(recorded.head).toBe(before);
      expect(repo.git('-C', task.worktree, 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(task.worktree, 'claimed.ts'), 'utf8')).toContain('work');
      expect(existsSync(repo.git('-C', task.worktree, 'rev-parse', '--git-path', 'rebase-merge'))).toBe(false);
    } finally { repo.dispose(); }
  });

  test.each(['staged', 'unstaged', 'untracked'])('leaves a %s change alone', async kind => {
    const repo = repository();
    try {
      const task = await stopped(repo);
      const before = repo.git('-C', task.worktree, 'rev-parse', 'HEAD');
      const file = kind === 'untracked' ? 'new-untracked.ts' : 'claimed.ts';
      writeFileSync(join(task.worktree, file), 'unfinished\n');
      if (kind === 'staged') repo.git('-C', task.worktree, 'add', file);
      const status = repo.git('-C', task.worktree, 'status', '--porcelain');
      advanceMain(repo);
      const resumed = repo.run('resume', task.id, '-m', 'Finish.');
      expect(resumed.status).toBe(0);
      expect(report(resumed.stdout)).toBe(`G-001 worktree: ${before} -> ${before}; 1 commits behind main; left alone: uncommitted changes`);
      expect((await repo.record(repo.ledger().tasks[task.id]!)).head).toBe(before);
      expect(repo.git('-C', task.worktree, 'status', '--porcelain')).toBe(status);
    } finally { repo.dispose(); }
  });

  test('leaves a worktree shared with another live task alone', async () => {
    const repo = repository();
    try {
      const task = await stopped(repo);
      const before = repo.git('-C', task.worktree, 'rev-parse', 'HEAD');
      const ledger = repo.ledger();
      ledger.tasks['G-002'] = { ...task, id: 'G-002', state: 'running', engine: 'grok',
        attempts: [{ ...task.attempts[0]!, pid: process.pid, engine: 'grok' }] };
      // A real live process carries the engine marker that running() checks in /proc.
      const live = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)', 'grok'], { stdout: 'ignore', stderr: 'ignore' });
      ledger.tasks['G-002']!.attempts[0]!.pid = live.pid;
      repo.save(ledger);
      try {
        advanceMain(repo);
        const resumed = repo.run('resume', task.id, '-m', 'Continue in the shared worktree.');
        expect(resumed.status).toBe(0);
        expect(report(resumed.stdout)).toBe(`G-001 worktree: ${before} -> ${before}; 1 commits behind main; left alone: live task G-002 shares the worktree`);
        expect((await repo.record(repo.ledger().tasks[task.id]!)).head).toBe(before);
      } finally { live.kill(); await live.exited; }
    } finally { repo.dispose(); }
  });

  test('reports a branch already on main without creating a commit', async () => {
    const repo = repository();
    try {
      const task = await stopped(repo);
      const head = repo.git('rev-parse', 'main');
      const resumed = repo.run('resume', task.id, '-m', 'Continue.');
      expect(resumed.status).toBe(0);
      expect(report(resumed.stdout)).toBe(`G-001 worktree: ${head} -> ${head}; 0 commits behind main; already current`);
      expect((await repo.record(repo.ledger().tasks[task.id]!)).head).toBe(head);
    } finally { repo.dispose(); }
  });
});

describe('blocked resume rounds', () => {
  test.each(['clean', 'commit', 'empty commit', 'dirty', 'untracked'])('a blocked handoff with %s work uses the appropriate round', async work => {
    const repo = repository();
    try {
      const task = await stopped(repo, 'blocked');
      if (work === 'commit') commitWork(repo, task);
      if (work === 'empty commit') repo.git('-C', task.worktree, 'commit', '--allow-empty', '-qm', 'Checkpoint');
      if (work === 'dirty' || work === 'untracked') writeFileSync(join(task.worktree, work === 'dirty' ? 'claimed.ts' : 'new-untracked.ts'), 'unfinished\n');
      advanceMain(repo);
      const resumed = repo.run('resume', task.id, '-m', 'The missing tooling is now available.');
      expect(resumed.status).toBe(0);
      const current = repo.ledger().tasks[task.id]!;
      expect(current.attempts.at(-1)!.round).toBe(work === 'clean' ? 'step' : 'fix');
      await repo.record(current);
    } finally { repo.dispose(); }
  });

  test('a clean blocked step needs no Decision even after both fixes', async () => {
    const repo = repository();
    try {
      const task = await stopped(repo, 'blocked');
      const ledger = repo.ledger();
      task.attempts.push({ ...task.attempts[0]!, n: 2, round: 'fix' }, { ...task.attempts[0]!, n: 3, round: 'fix' });
      ledger.tasks[task.id] = task;
      repo.save(ledger);
      const resumed = repo.run('resume', task.id, '-m', 'The blocker is resolved.');
      expect(resumed.status).toBe(0);
      const current = repo.ledger().tasks[task.id]!;
      expect(current.attempts.at(-1)!.round).toBe('step');
      expect(current.attempts.filter(attempt => attempt.round === 'fix')).toHaveLength(2);
      await repo.record(current);
    } finally { repo.dispose(); }
  });

  test('a blocked attempt that made a commit still counts as a fix after that commit lands', async () => {
    const repo = repository();
    try {
      const task = await stopped(repo, 'blocked');
      commitWork(repo, task);
      repo.git('merge', '--ff-only', task.branch);
      const ledger = repo.ledger();
      ledger.tasks[task.id]!.state = 'merged';
      repo.save(ledger);
      const resumed = repo.run('resume', task.id, '-m', 'Resolve the blocker.');
      expect(resumed.status).toBe(0);
      const current = repo.ledger().tasks[task.id]!;
      expect(current.attempts.at(-1)!.round).toBe('fix');
      await repo.record(current);
    } finally { repo.dispose(); }
  });

  test('an unchanged blocked attempt with work from an earlier attempt advances a step', async () => {
    const repo = repository();
    try {
      const task = await stopped(repo);
      commitWork(repo, task);
      advanceMain(repo);
      expect(repo.run('resume', task.id, '-m', 'Continue.').status).toBe(0);
      await repo.record(repo.ledger().tasks[task.id]!);
      settle(repo, 'blocked');
      const resumed = repo.run('resume', task.id, '-m', 'The blocker is resolved.');
      expect(resumed.status).toBe(0);
      const current = repo.ledger().tasks[task.id]!;
      expect(current.attempts.at(-1)!.round).toBe('step');
      expect(current.attempts.filter(attempt => attempt.round === 'fix')).toHaveLength(1);
      await repo.record(current);
    } finally { repo.dispose(); }
  });
});
