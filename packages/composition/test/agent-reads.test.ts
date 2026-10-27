import { expect, test } from 'bun:test';
import { planReads, platformRegistry, readCost, validateComposition } from '../src/index.ts';

const accountId = '018f0000-0000-7000-8000-00a000000001';
const accountHandle = 'agent_1';
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const document = {
  root: { props: {} },
  content: [
    node('AccountIdentity', 'identity', { handle: accountHandle }),
    node('AccountThreads', 'discussions', { threadKind: 'discussion', limit: 12 }),
    node('AccountThreads', 'reviews', { threadKind: 'review', limit: 10 }),
    node('AccountPosts', 'posts', { limit: 8, cursor: 'reply-cursor' }),
    node('AccountCollections', 'collections', { limit: 24, cursor: 'collection-cursor' }),
  ],
};

test('account pages first read identity by handle, then plan account lists by its resolved id', () => {
  expect(validateComposition(platformRegistry, document)).toEqual([]);
  expect(planReads(platformRegistry, document, { subject: null })).toEqual({
    reads: { r0: { kind: 'account', handle: accountHandle } },
    nodes: { identity: 'r0' },
  });
  const plan = planReads(platformRegistry, document, { subject: null, accountId });
  expect(plan.reads).toEqual({
    r0: { kind: 'account', handle: accountHandle },
    r1: { kind: 'accountThreads', id: accountId, threadKind: 'discussion', limit: 12 },
    r2: { kind: 'accountThreads', id: accountId, threadKind: 'review', limit: 10 },
    r3: { kind: 'accountPosts', id: accountId, limit: 8, cursor: 'reply-cursor' },
    r4: { kind: 'accountCollections', id: accountId, limit: 24, cursor: 'collection-cursor' },
  });
  expect(plan.nodes).toEqual({ identity: 'r0', discussions: 'r1', reviews: 'r2', posts: 'r3', collections: 'r4' });
  expect(Object.values(plan.reads).map(readCost)).toEqual([1, 12, 10, 8, 24]);
});

test('account page reads enforce each standalone page limit', () => {
  const invalid = (type: string, id: string, props: Record<string, unknown>) =>
    validateComposition(platformRegistry, { root: { props: {} }, content: [node(type, id, props)] });
  expect(invalid('AccountThreads', 'threads', { threadKind: 'discussion', limit: 21 })).toEqual([
    { pointer: '/content/0/props/limit', code: 'invalid' },
  ]);
  expect(invalid('AccountPosts', 'posts', { limit: 0 })).toEqual([
    { pointer: '/content/0/props/limit', code: 'invalid' },
  ]);
  expect(invalid('AccountCollections', 'collections', { limit: 25 })).toEqual([
    { pointer: '/content/0/props/limit', code: 'invalid' },
  ]);
});

test('publish-time page cost includes account lists that are planned after identity lookup', () => {
  const over = {
    root: { props: {} },
    content: [
      node('AccountIdentity', 'identity', { handle: accountHandle }),
      ...Array.from({ length: 7 }, (_, index) =>
        node('AccountPosts', `posts-${index}`, { limit: 20, cursor: `cursor-${index}` }),
      ),
    ],
  };
  expect(validateComposition(platformRegistry, over)).toEqual([{ pointer: '/content', code: 'limit' }]);
});
