import { expect, test } from 'bun:test';
import { workerPrompt } from './launch.ts';
import type { Task } from './types.ts';

test('the worker prompt names the main checkout as read-only and asks for paths inside the worktree', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    mainCheckout: '/repo/main',
    brief: { markdown: 'Do the thing.', acceptance: { command: ['bun', 'test'], tests: ['x'] } },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('/repo/main is read-only');
  expect(prompt).toContain('Write files only by paths inside /work/trees/t1');
});

test('the worker prompt says failures outside the declared paths are reported, not blocking', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    mainCheckout: '/repo/main',
    brief: {
      markdown: 'Do the thing.',
      paths: ['src/a.ts'],
      acceptance: { command: ['bun', 'test', 'a.test.ts'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('A failure that also occurs on your base commit is not your blocker');
  expect(prompt).toContain('A test that passes on your base and fails after your change is yours');
});

test('the worker prompt forbids touching resources the attempt did not start', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    mainCheckout: '/repo/main',
    brief: {
      markdown: 'Do the thing.',
      paths: ['src/a.ts'],
      acceptance: { command: ['bun', 'test', 'a.test.ts'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('Never stop or remove containers, databases or processes you did not start in this attempt');
});

test('every worker can ask for research, and a research worker is told how to do it', () => {
  const brief = (kind: string) => ({
    markdown: 'Do the thing.',
    kind,
    paths: ['docs/research/x.md'],
    acceptance: { command: ['test', '-s', 'docs/research/x.md'], tests: ['x'] },
  });
  const task = (kind: string) =>
    ({ worktree: '/work/trees/t1', branch: 'worker/t1', brief: brief(kind) }) as unknown as Task;
  const implementation = workerPrompt(task('implementation'), undefined, undefined, [], '/repo/main');
  expect(implementation).toContain('Research needed:');
  expect(implementation).not.toContain('This is a research task');
  const research = workerPrompt(task('research'), undefined, undefined, [], '/repo/main');
  expect(research).toContain('This is a research task');
  expect(research).toContain('.reference/<topic>/<project>/');
  expect(research).toContain('never install, build or run anything from them');
  expect(research).toContain('except the reference clones this research task keeps under /repo/main/.reference/');
  expect(implementation).not.toContain('except the reference clones');
});

test('a worker starts only below the worker cap and above the memory floor', async () => {
  const { hasCapacity } = await import('./launch.ts');
  const capacity = { maxWorkers: 32, minAvailableMiB: 6144 };
  expect(hasCapacity(31, 8000, capacity)).toBe(true);
  expect(hasCapacity(32, 8000, capacity)).toBe(false);
  expect(hasCapacity(10, 4000, capacity)).toBe(false);
});

test('a worker writes acceptance tests the contract names and waits for queued checks', () => {
  const task = {
    worktree: '/work/trees/t1',
    branch: 'worker/t1',
    brief: {
      markdown: 'Do the thing.',
      kind: 'implementation',
      acceptance: { command: ['bun', 'test'], tests: ['x'] },
    },
  } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('Write every acceptance test the contract names that does not exist yet');
  expect(prompt).toContain('never weaken or edit an existing acceptance test');
  expect(prompt).toContain('queued, not stuck');
});

test('stabilize and critical-path starts skip the worker cap but not the memory floor', async () => {
  const { startsFirst } = await import('./launch.ts');
  expect(startsFirst({ taskClass: 'claim', brief: { target: 'stabilize' } } as never)).toBe(true);
  expect(startsFirst({ taskClass: 'critical-path', brief: {} } as never)).toBe(true);
  expect(startsFirst({ taskClass: 'claim', brief: { criticalPath: true } } as never)).toBe(true);
  expect(startsFirst({ taskClass: 'implementation', brief: {} } as never)).toBe(false);
});

test('a capacity waiter counts only live, older tickets ahead of it and clears ended ones', async () => {
  const { waitersAhead } = await import('./launch.ts');
  const { mkdtempSync, writeFileSync: write, existsSync: exists } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const queue = mkdtempSync(joinPath(tmpdir(), 'capacity-queue-'));
  const live = `${'1'.padStart(15, '0')}-${process.pid}-a`;
  const ended = `${'2'.padStart(15, '0')}-2147483646-b`;
  const mine = `${'3'.padStart(15, '0')}-${process.pid}-c`;
  const newer = `${'4'.padStart(15, '0')}-${process.pid}-d`;
  for (const name of [live, ended, mine, newer]) write(joinPath(queue, name), '');
  expect(waitersAhead(queue, mine)).toBe(1);
  expect(exists(joinPath(queue, ended))).toBe(false);
  expect(waitersAhead(queue, live)).toBe(0);
});

test('a worker is told where reference projects are and to read the ones its contract names', () => {
  const task = { worktree: '/work/trees/t1', branch: 'worker/t1', brief: { markdown: 'Do the thing.', kind: 'implementation', acceptance: { command: ['bun', 'test'], tests: ['x'] } } } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('/repo/main/.reference/');
  expect(prompt).toContain('read that source for the surface you build before you design it');
});
