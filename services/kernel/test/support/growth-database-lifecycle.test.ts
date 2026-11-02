import { expect, test } from 'bun:test';
import { createGrowthDatabaseLifecycle } from './growth-capture.ts';

test('setup failure closes every acquired pool and reports cleanup failures with the setup error', async () => {
  const lifecycle = createGrowthDatabaseLifecycle();
  const closed: string[] = [];
  const setupError = new Error('probe failed');
  const cleanupError = new Error('socket refused');

  await expect(
    lifecycle.setup(async () => {
      lifecycle.acquire('instrumented pool', () => ({ end: async () => void closed.push('instrumented') }));
      lifecycle.acquire('admin pool', () => ({ end: async () => { closed.push('admin'); throw cleanupError; } }));
      throw setupError;
    }),
  ).rejects.toMatchObject({
    message: expect.stringContaining('probe failed'),
    errors: [setupError, expect.objectContaining({ message: expect.stringContaining('admin pool') })],
  });
  expect(closed.sort()).toEqual(['admin', 'instrumented']);
});

test('close is repeatable, drains every pool after a failure, and rejects new acquisitions', async () => {
  const lifecycle = createGrowthDatabaseLifecycle();
  const closed: string[] = [];
  let acquiredAfterClose = false;
  lifecycle.acquire('library pool', () => ({ end: async () => { closed.push('library'); throw new Error('close failed'); } }));
  lifecycle.acquire('admin pool', () => ({ end: async () => void closed.push('admin') }));

  const closing = lifecycle.close();
  expect(lifecycle.close()).toBe(closing);
  expect(() => lifecycle.acquire('late pool', () => {
    acquiredAfterClose = true;
    return { end: async () => {} };
  })).toThrow('Growth database is closed');
  await expect(closing).rejects.toMatchObject({
    message: expect.stringContaining('library pool failed to close: close failed'),
  });
  expect(closed.sort()).toEqual(['admin', 'library']);
  expect(acquiredAfterClose).toBe(false);
});
