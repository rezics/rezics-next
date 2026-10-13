import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository } from './handover.test.ts';
import type { QueueLedger } from './queue.ts';

describe('interrupted dispatch recovery', () => {
  for (const command of ['dispatch', 'queue']) {
    test(`${command} removes a clean leftover and starts from current main`, async () => {
      const repo = repository();
      try {
        const worktree = join(repo.local, 'worktrees/g-001');
        repo.git('worktree', 'add', '-qb', 'goal/g-001', worktree, 'main');
        mkdirSync(join(worktree, '.temp'), { recursive: true });
        writeFileSync(join(worktree, '.temp/interrupted'), 'unfinished dispatch');
        writeFileSync(join(repo.dir, 'claimed.ts'), 'export const current = true;\n');
        repo.git('commit', '-qam', 'Main advances');
        const result = repo.run(command, repo.brief());
        expect(result.status, result.stderr).toBe(0);
        const task = repo.ledger().tasks['G-001']!;
        expect((await repo.record(task)).head).toBe(repo.git('rev-parse', 'main'));
        expect(existsSync(join(worktree, '.temp/interrupted'))).toBe(false);
      } finally { repo.dispose(); }
    });

    test.each(['commit', 'empty commit', 'unstaged', 'staged', 'untracked'])(`${command} refuses a leftover with %s`, kind => {
      const repo = repository();
      try {
        const worktree = join(repo.local, 'worktrees/g-001');
        repo.git('worktree', 'add', '-qb', 'goal/g-001', worktree, 'main');
        if (kind === 'empty commit') repo.git('-C', worktree, 'commit', '--allow-empty', '-qm', 'Worker checkpoint');
        else {
          const file = kind === 'untracked' ? 'new-file.ts' : 'claimed.ts';
          writeFileSync(join(worktree, file), 'unfinished work\n');
          if (kind === 'staged' || kind === 'commit') repo.git('-C', worktree, 'add', file);
          if (kind === 'commit') repo.git('-C', worktree, 'commit', '-qm', 'Worker checkpoint');
        }
        const head = repo.git('-C', worktree, 'rev-parse', 'HEAD');
        const status = repo.git('-C', worktree, 'status', '--porcelain');
        const result = repo.run(command, repo.brief());
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('already exists');
        expect(repo.git('rev-parse', 'goal/g-001')).toBe(head);
        expect(repo.git('-C', worktree, 'status', '--porcelain')).toBe(status);
        expect(repo.ledger().tasks).toEqual({});
      } finally { repo.dispose(); }
    });

    test(`${command} refuses an existing task even with a clean worktree`, async () => {
      const repo = repository();
      try {
        const brief = repo.brief();
        expect(repo.run('dispatch', brief).status).toBe(0);
        const task = repo.ledger().tasks['G-001']!;
        await repo.record(task);
        const result = repo.run(command, brief);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('already exists');
        expect(existsSync(task.worktree)).toBe(true);
        expect(repo.git('rev-parse', task.branch)).toBe(task.base);
      } finally { repo.dispose(); }
    });
  }
});

function goalBrief(repo: ReturnType<typeof repository>, id: string, depends: string[], goal = 'program'): string {
  const file = join(repo.dir, 'docs/goals', goal, 'tasks', `${id}.md`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, readFileSync(repo.brief(), 'utf8').replace('id: G-001', `id: ${id}`)
    .replace('paths: [claimed.ts, new*.ts]', `paths: [${id.toLowerCase()}.ts]\ndepends: [${depends.join(', ')}]`));
  return file;
}

describe('queued dependencies', () => {
  test('a chain queued in one turn dispatches in dependency order', async () => {
    const repo = repository();
    try {
      const ledger: QueueLedger = repo.ledger();
      ledger.goals = { program: { manager: 'recording-manager', startedAt: new Date().toISOString() } };
      ledger.tasks['G-001'] = { id: 'G-001', title: 'Prior work', kind: 'tooling', effort: 'high', cases: [],
        paths: [], shared: [], depends: [], migrations: [], worktree: repo.dir, branch: 'main',
        base: repo.git('rev-parse', 'HEAD'), brief: '', state: 'stopped', goal: 'program', attempts: [] };
      repo.save(ledger);
      expect(repo.run('queue', goalBrief(repo, 'G-002', ['G-001'])).status).toBe(0);
      const result = repo.run('queue', goalBrief(repo, 'G-003', ['G-002']));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('depends on G-002, which is queued');
      expect(repo.run('queue').stdout).toContain('depends on G-002, which is queued');
      expect((repo.ledger() as QueueLedger).queue?.['G-003']?.waits).toEqual(['G-003 depends on G-002, which is queued']);
      const ready = repo.ledger();
      ready.tasks['G-001']!.state = 'verified';
      repo.save(ready);
      expect(repo.run('settle').status).toBe(0);
      const started = repo.ledger();
      await repo.record(started.tasks['G-002']!);
      expect(started.tasks['G-003']).toBeUndefined();
      expect((started as QueueLedger).queue?.['G-003']).toBeDefined();
      started.tasks['G-002']!.state = 'verified';
      started.tasks['G-002']!.attempts[0]!.pid = 0;
      repo.save(started);
      expect(repo.run('settle').status).toBe(0);
      const finished = repo.ledger();
      await repo.record(finished.tasks['G-003']!);
      expect((finished as QueueLedger).queue).toEqual({});
    } finally { repo.dispose(); }
  });

  test.each(['unknown', 'queued in another Goal', 'task in another Goal'])('refuses a dependency that is %s', kind => {
    const repo = repository();
    try {
      const ledger: QueueLedger = repo.ledger();
      ledger.goals = Object.fromEntries(['program', 'api'].map(goal =>
        [goal, { manager: 'recording-manager', startedAt: new Date().toISOString() }]));
      if (kind === 'queued in another Goal') ledger.queue = { 'G-002': { id: 'G-002', goal: 'api',
        brief: goalBrief(repo, 'G-002', [], 'api'), queuedAt: new Date().toISOString(), waits: [] } };
      if (kind === 'task in another Goal') ledger.tasks['G-002'] = { id: 'G-002', title: 'Other Goal',
        effort: 'high', cases: [], paths: [], shared: [], depends: [], migrations: [], worktree: repo.dir,
        branch: 'main', base: repo.git('rev-parse', 'HEAD'), brief: '', state: 'verified', goal: 'api', attempts: [] };
      repo.save(ledger);
      const result = repo.run('queue', goalBrief(repo, 'G-003', ['G-002']));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(kind === 'unknown' ? 'Unknown dependency' : 'another Goal');
      expect((repo.ledger() as QueueLedger).queue?.['G-003']).toBeUndefined();
    } finally { repo.dispose(); }
  });
});
