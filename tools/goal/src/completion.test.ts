import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { completionChecker } from './completion.ts';
import { repository } from './test-support.ts';

test('completion requires every declared task and a passing gate on main', async () => {
  const repo = repository();
  try {
    let merged = new Set<string>(); let passing = true; let calls = 0;
    const check = completionChecker({ mainCheckout: repo.main, stateDirectory: join(repo.path, 'state'), worktreeRoot: join(repo.path, 'trees'),
      condition: () => ({ taskIds: ['alpha', 'beta'], gate: ['true'] }), mergedTasks: async () => merged,
      runGate: async (_, cwd) => {
        expect(cwd).not.toBe(repo.main); calls++;
        return { passed: passing, timedOut: false, output: passing ? '' : 'error: assertion on main' };
      } });
    expect((await check('refactor')).passed).toBe(false); expect(calls).toBe(0);
    merged = new Set(['alpha', 'beta']); passing = false;
    const failed = await check('refactor'); expect(failed.passed).toBe(false); expect(failed.summary).toContain('Main gate failed');
    passing = true; expect((await check('refactor')).passed).toBe(true);
  } finally { repo.close(); }
});

test('completion rejects a main movement while its gate runs', async () => {
  const repo = repository();
  try {
    const check = completionChecker({ mainCheckout: repo.main, stateDirectory: join(repo.path, 'state'), worktreeRoot: join(repo.path, 'trees'),
      condition: () => ({ taskIds: [], gate: ['true'] }), mergedTasks: async () => new Set(),
      runGate: async () => { repo.commit('moved'); return { passed: true, timedOut: false, output: '' }; } });
    expect((await check('refactor')).summary).toContain('Main moved');
  } finally { repo.close(); }
});

test('a changed task scope invalidates a completion proposal', async () => {
  const repo = repository();
  try {
    let tasks = ['alpha'];
    const check = completionChecker({ mainCheckout: repo.main, stateDirectory: join(repo.path, 'state'), worktreeRoot: join(repo.path, 'trees'),
      condition: () => ({ taskIds: tasks, gate: ['true'] }), mergedTasks: async () => new Set(['alpha']),
      runGate: async () => { tasks = ['alpha', 'beta']; return { passed: true, timedOut: false, output: '' }; } });
    expect((await check('refactor')).summary).toContain('Goal condition changed');
  } finally { repo.close(); }
});
