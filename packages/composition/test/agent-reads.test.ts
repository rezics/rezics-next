import { expect, test } from 'bun:test';
import { planReads, platformRegistry, readCost, validateComposition } from '../src/index.ts';

const account = { id: '018f0000-0000-7000-8000-00a000000001', handle: 'agent_1' };
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const page = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });
const document = page(
  node('AccountIdentity', 'identity'),
  node('AccountThreads', 'discussions', { threadKind: 'discussion', limit: 12 }),
  node('AccountThreads', 'reviews', { threadKind: 'review', limit: 10 }),
  node('AccountPosts', 'posts', { limit: 8 }),
  node('AccountCollections', 'collections', { limit: 24 }),
);

test('account components read the page target account in one plan', () => {
  expect(validateComposition(platformRegistry, document)).toEqual([]);
  const plan = planReads(platformRegistry, document, { subject: null, account });
  expect(plan.reads).toEqual({
    r0: { kind: 'account', handle: account.handle },
    r1: { kind: 'accountThreads', id: account.id, threadKind: 'discussion', limit: 12 },
    r2: { kind: 'accountThreads', id: account.id, threadKind: 'review', limit: 10 },
    r3: { kind: 'accountPosts', id: account.id, limit: 8 },
    r4: { kind: 'accountCollections', id: account.id, limit: 24 },
  });
  expect(plan.nodes).toEqual({ identity: 'r0', discussions: 'r1', reviews: 'r2', posts: 'r3', collections: 'r4' });
  expect(Object.values(plan.reads).map(readCost)).toEqual([1, 12, 10, 8, 24]);
});

test('account components plan nothing without a page account', () => {
  expect(planReads(platformRegistry, document, { subject: null })).toEqual({ reads: {}, nodes: {} });
  expect(planReads(platformRegistry, document, { subject: null, account: null })).toEqual({ reads: {}, nodes: {} });
});

test('a document cannot fix an account handle or a continuation cursor', () => {
  const errors = (type: string, props: Record<string, unknown>) =>
    validateComposition(platformRegistry, page(node(type, 'n', props)));
  expect(errors('AccountIdentity', { handle: 'agent_1' })).toEqual([
    { pointer: '/content/0/props/handle', code: 'invalid' },
  ]);
  expect(errors('AccountThreads', { threadKind: 'review', limit: 5, cursor: 'c' })).toEqual([
    { pointer: '/content/0/props/cursor', code: 'invalid' },
  ]);
  expect(errors('AccountPosts', { limit: 5, cursor: 'c' })).toEqual([
    { pointer: '/content/0/props/cursor', code: 'invalid' },
  ]);
  expect(errors('AccountCollections', { limit: 5, cursor: 'c' })).toEqual([
    { pointer: '/content/0/props/cursor', code: 'invalid' },
  ]);
});

test('account page reads enforce each standalone page limit', () => {
  const errors = (type: string, props: Record<string, unknown>) =>
    validateComposition(platformRegistry, page(node(type, 'n', props)));
  expect(errors('AccountThreads', { threadKind: 'discussion', limit: 21 })).toEqual([
    { pointer: '/content/0/props/limit', code: 'limit' },
  ]);
  expect(errors('AccountPosts', { limit: 0 })).toEqual([{ pointer: '/content/0/props/limit', code: 'limit' }]);
  expect(errors('AccountCollections', { limit: 25 })).toEqual([{ pointer: '/content/0/props/limit', code: 'limit' }]);
});

test('publish-time page cost counts account lists', () => {
  // 1 + (20 + 19 + 18) * 2 + 20 = 135 rows over 8 distinct reads.
  const over = page(
    node('AccountIdentity', 'identity'),
    ...[20, 19, 18].flatMap((limit) => [
      node('AccountThreads', `discussions-${limit}`, { threadKind: 'discussion', limit }),
      node('AccountThreads', `reviews-${limit}`, { threadKind: 'review', limit }),
    ]),
    node('AccountPosts', 'posts', { limit: 20 }),
  );
  expect(validateComposition(platformRegistry, over)).toEqual([{ pointer: '/content', code: 'limit' }]);
});
