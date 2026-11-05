import { expect, mock, test } from 'bun:test';
import type { CompositionNode } from '@rezics/composition';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { continueAgentList } = await import('../src/features/pages/agent');

const node = (id: string, type = 'AccountPosts', props: Record<string, unknown> = { limit: 3 }): CompositionNode => ({
  type,
  props: { id, ...props },
});
const page = (content: CompositionNode[]): Parameters<typeof continueAgentList>[1] => ({
  subject: null,
  account: { id: 'account-id', handle: 'reader' },
  profile: 'profile',
  template: { scope: 'type', key: 'schema:Person' },
  document: { root: { props: {} }, content },
  reads: { r0: { status: 200, body: { handle: 'reader' } }, r1: { status: 200, body: { next: 'opaque' } } },
});

test('a bare cursor refuses missing or ambiguous lists in either descriptor order before requesting anything', async () => {
  const posts = node('posts');
  const review = node('review', 'AccountThreads', { limit: 3, threadKind: 'review' });
  const discussion = node('discussion', 'AccountThreads', { limit: 3, threadKind: 'discussion' });
  const pairs = [
    [posts, node('collections', 'AccountCollections')],
    [review, discussion],
    [posts, node('more', 'AccountPosts', { limit: 4 })],
  ];
  const accounts = mock(() => {
    throw new Error('unexpected standalone request');
  });
  for (const content of [
    [],
    [node('identity', 'AccountIdentity', {})],
    ...pairs.flatMap((pair) => [pair, [...pair].reverse()]),
  ]) {
    await expect(continueAgentList({ accounts } as never, page(content), 'opaque')).rejects.toMatchObject({
      state: 'unavailable',
    });
  }
  expect(accounts).not.toHaveBeenCalled();
});

test('one shared list descriptor continues once and preserves the other page reads', async () => {
  const original = page([node('identity', 'AccountIdentity', {}), node('posts'), node('same-posts')]);
  const outcome = { status: 200, data: { posts: [], next: 'next-opaque' } };
  const get = mock(async (_request: unknown) => outcome);
  const accounts = mock((_input: unknown) => ({ posts: { get } }));
  const result = await continueAgentList({ accounts } as never, original, 'opaque');
  expect(get.mock.calls).toEqual([[{ query: { cursor: 'opaque', limit: 3 } }]]);
  expect(result).toEqual({ ...original, reads: { ...original.reads, r1: { status: 200, body: outcome.data } } });
});

test('Collections forwards the exact opaque cursor and planned BASIC limit without changing its descriptor', async () => {
  const original = page([node('collections', 'AccountCollections', { limit: 24, paged: true })]);
  const get = mock(async (_request: unknown) => ({ status: 200, data: { collections: [], next: null } }));
  const accounts = mock((_input: unknown) => ({ collections: { get } }));
  const descriptor = structuredClone(original.document);
  await continueAgentList({ accounts } as never, original, 'opaque+/=%&cursor');
  expect(accounts.mock.calls).toEqual([[{ accountId: 'account-id' }]]);
  expect(get.mock.calls).toEqual([[{ query: { cursor: 'opaque+/=%&cursor', limit: 24, view: 'BASIC' } }]]);
  expect(original.document).toEqual(descriptor);
});
