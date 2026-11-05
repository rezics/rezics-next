import { expect, test } from 'bun:test';
import type { Actor } from '../../src/request/access.ts';
import { REACTION_KINDS } from '../../src/content/events.ts';
import { feedReactionAdviceFromOperations } from '../../src/content/feed-reaction-advice.ts';

test('native Content reaction advice distinguishes allowed, denied, sign-in and unavailable states', () => {
  const actor: Actor = {
    kind: 'account',
    accountId: crypto.randomUUID(),
    clientId: 'feed-reaction-test',
    scopes: [],
    requestedBy: null,
    authnEpoch: 0,
  };
  const anonymous: Actor = { kind: 'anonymous' };
  const thread = { targetKind: 'thread', targetId: crypto.randomUUID() } as const;
  const post = { targetKind: 'post', targetId: crypto.randomUUID() } as const;
  const threadOps = new Set(['thread.set_reaction', 'thread.clear_reaction']);
  const postOps = new Set(['post.set_reaction', 'post.clear_reaction']);
  const security = new Map([
    ['thread.set_reaction', 'authenticated'],
    ['thread.clear_reaction', 'authenticated'],
    ['post.set_reaction', 'authenticated'],
    ['post.clear_reaction', 'authenticated'],
  ] as const);

  expect(feedReactionAdviceFromOperations(actor, thread, 'content.thread', threadOps, security)).toEqual({
    target: thread,
    state: 'current',
    allowed: [...REACTION_KINDS],
  });
  expect(feedReactionAdviceFromOperations(actor, thread, 'content.thread', new Set(), security)).toEqual({
    target: thread,
    state: 'current',
    allowed: [],
  });
  expect(feedReactionAdviceFromOperations(actor, post, 'content.post', postOps, security)).toEqual({
    target: post,
    state: 'current',
    allowed: [...REACTION_KINDS],
  });
  expect(feedReactionAdviceFromOperations(anonymous, post, 'content.post', new Set(), security)).toEqual({
    target: post,
    state: 'sign_in',
  });
  expect(
    feedReactionAdviceFromOperations(
      anonymous,
      post,
      'content.post',
      new Set(),
      new Map([['post.set_reaction', 'unknown']]),
    ),
  ).toEqual({ target: post, state: 'unavailable' });
  expect(
    feedReactionAdviceFromOperations(actor, post, 'content.post', new Set(['post.set_reaction']), security),
  ).toEqual({ target: post, state: 'unavailable' });
});
