import { expect, test } from 'bun:test';
import { readPage, PageReadError } from '../../src/presentation/reads.ts';

test('aggregate execution refuses192 requested slots before a standalone read is dispatched', async () => {
  let calls = 0;
  const operation = readPage({
    incoming: new Request('http://kernel.test/v1/pages:read'),
    reads: {
      a: { kind: 'search', body: { text: 'one', limit: 64 } },
      b: { kind: 'search', body: { text: 'two', limit: 64 } },
      c: { kind: 'search', body: { text: 'three', limit: 64 } },
    },
    session: { ring: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) }, scope: 'aggregate-admission' },
    async dispatch() {
      calls++;
      return Response.json({ subjects: [], next: null, as_of: new Date().toISOString() });
    },
  });
  await expect(operation).rejects.toBeInstanceOf(PageReadError);
  expect(calls).toBe(0);
});
