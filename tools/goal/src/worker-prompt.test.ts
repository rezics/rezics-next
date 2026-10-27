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
  expect(prompt).toContain('A failure that also occurs on your base commit is not your blocker');
  expect(prompt).toContain('A test that passes on your base and fails after your change is yours');
});

test('the worker prompt forbids touching resources the attempt did not start', () => {
  const task = { worktree: '/work/trees/t1', branch: 'worker/t1', mainCheckout: '/repo/main',
    brief: { markdown: 'Do the thing.', paths: ['src/a.ts'], acceptance: { command: ['bun', 'test', 'a.test.ts'], tests: ['x'] } } } as unknown as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/repo/main');
  expect(prompt).toContain('Never stop or remove containers, databases or processes you did not start in this attempt');
});

test('every worker can ask for research, and a research worker is told how to do it', () => {
  const brief = (kind: string) => ({ markdown: 'Do the thing.', kind, paths: ['docs/research/x.md'],
    acceptance: { command: ['test', '-s', 'docs/research/x.md'], tests: ['x'] } });
  const task = (kind: string) => ({ worktree: '/work/trees/t1', branch: 'worker/t1', brief: brief(kind) }) as unknown as Task;
  const implementation = workerPrompt(task('implementation'), undefined, undefined, [], '/repo/main');
  expect(implementation).toContain('Research needed:');
  expect(implementation).not.toContain('This is a research task');
  const research = workerPrompt(task('research'), undefined, undefined, [], '/repo/main');
  expect(research).toContain('This is a research task');
  expect(research).toContain('/home/edge/projects/rezics/temp/<topic>-refs/');
  expect(research).toContain('never install, build or run anything from them');
});
