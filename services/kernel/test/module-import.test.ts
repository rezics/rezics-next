import { expect, test } from 'bun:test';

// The Kernel check runner supplies the migrated database and SQL module loader.
test('both process entries import without evaluating cyclic module values', async () => {
  const server = await import('../src/server.ts');
  const worker = await import('../src/worker.ts');
  expect(typeof server.startServer).toBe('function');
  expect(typeof worker.startWorker).toBe('function');
});
