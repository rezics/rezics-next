import { expect, test } from 'bun:test';
import { workerPrompt } from './launch.ts';
import type { Task } from './types.ts';

test('the worker prompt names the main checkout as read-only and asks for paths inside the worktree', () => {
  const task = { worktree: '/work/trees/t1', branch: 'worker/t1', mainCheckout: '/repo/main',
    brief: { markdown: 'Do the thing.', acceptance: { command: ['bun', 'test'], tests: ['x'] } } } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('/repo/main is read-only');
  expect(prompt).toContain('Write files only by paths inside /work/trees/t1');
});

test('the worker prompt says failures outside the declared paths are reported, not blocking', () => {
  const task = { worktree: '/work/trees/t1', branch: 'worker/t1', mainCheckout: '/repo/main',
    brief: { markdown: 'Do the thing.', paths: ['src/a.ts'], acceptance: { command: ['bun', 'test', 'a.test.ts'], tests: ['x'] } } } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('A failure outside your declared paths is not your blocker');
});
