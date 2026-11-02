import { expect, mock, test } from 'bun:test';

test('author erasure scope survives a transient personal and session read gap but changes with the actor', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { authorErasureEntryScope } = await import('../src/threads/author-erasure-entry');
  const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const authorA = '0192f3a0-6c1e-7b2a-9d4e-000000000006';
  const authorB = '0192f3a0-6c1e-7b2a-9d4e-000000000007';
  const current = authorErasureEntryScope(threadId, authorA, undefined, null);
  const gap = authorErasureEntryScope(threadId, null, undefined, current.viewerId);
  expect(gap).toEqual(current);
  expect(authorErasureEntryScope(threadId, authorB, undefined, gap.viewerId).key).not.toBe(current.key);
});
