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
