import { expect, test } from 'bun:test';
import { boardOpeningCard, boardOpeningExample, boardOpeningNow } from '../src/threads/board-opening-fixtures';
import {
  boardOpeningReaction,
  receiveBoardOpeningPage,
  type BoardOpeningReactionOrigin,
} from '../src/threads/board-opening';

function admittedCard() {
  const card = boardOpeningCard(1);
  card.actions.react = 'allowed';
  card.interaction = {
    ...card.interaction,
    counts: { state: 'as-of', values: { like: 3, upvote: 0 }, source: { epoch: 2, position: '12' } },
    viewer: { state: 'current', reaction: null },
  };
  return card;
}

test('Board reactions need native advice, a current viewer slot and the current page reader', () => {
  const card = admittedCard();
  let current = true;
  const origin: BoardOpeningReactionOrigin = { key: 'board-visit', reader: 'reader-one', isCurrent: () => current };
  const admitted = boardOpeningReaction(card, true, origin);
  expect(admitted).toMatchObject({
    target: { kind: 'thread', id: card.thread.id },
    counts: { like: 3, upvote: 0 },
    value: null,
    personalReady: true,
    signInAllowed: false,
    settleWithRead: true,
    reactionOrigin: { key: 'board-visit', reader: 'reader-one' },
    sourceWatermark: { epoch: 2, position: '12' },
  });

  if (card.interaction.counts.state !== 'as-of') throw new Error('Expected selected counts');
  Object.assign(card.interaction.counts.values, { like: 8 });
  Object.assign(card.interaction.counts.source, { position: '13' });
  expect(admitted.counts).toEqual({ like: 3, upvote: 0 });
  expect(admitted.sourceWatermark).toEqual({ epoch: 2, position: '12' });
  expect(boardOpeningReaction(card, true, origin).counts).toEqual({ like: 8, upvote: 0 });

  current = false;
  expect(boardOpeningReaction(card, true, origin).personalReady).toBe(false);
  expect(boardOpeningReaction(card, true, { ...origin, reader: null }).personalReady).toBe(false);
  expect(
    boardOpeningReaction(
      { ...card, interaction: { ...card.interaction, viewer: { state: 'not-applicable' } } },
      true,
      origin,
    ).personalReady,
  ).toBe(false);

  current = true;
  const signedOut = admittedCard();
  signedOut.actions.react = 'sign-in';
  expect(
    boardOpeningReaction(signedOut, false, { key: 'anonymous', reader: null, isCurrent: () => true }),
  ).toMatchObject({
    personalReady: false,
    signInAllowed: true,
    settleWithRead: false,
  });
  for (const advice of ['denied', 'unavailable'] as const) {
    const refused = admittedCard();
    refused.actions.react = advice;
    expect(boardOpeningReaction(refused, true, origin)).toMatchObject({
      personalReady: false,
      signInAllowed: false,
      settleWithRead: false,
    });
  }
});

test('the initial pin wins overlap and each replacement keeps its selected counts and activity witness', () => {
  const response = boardOpeningExample('interactions');
  const pin = response.pinnedThreads[0]!;
  const threadId = pin.thread.id;
  pin.actions.react = 'allowed';
  pin.interaction.viewer = { state: 'current', reaction: null };
  response.threads.unshift({
    ...pin,
    actions: { ...pin.actions, react: 'unavailable' },
    comments: {
      state: 'current',
      cohort: 'public',
      count: { kind: 'exact', value: 99 },
      lastActivityAt: boardOpeningNow,
      source: { epoch: 9, position: '90' },
    },
  });

  const first = receiveBoardOpeningPage(response);
  const selected = first.openingCards[threadId]!;
  expect(selected.actions.react).toBe('allowed');
  expect(selected.comments).toEqual(pin.comments);
  expect(selected.interaction.counts).toEqual(pin.interaction.counts);
  expect(
    boardOpeningReaction(selected, true, { key: 'page', reader: 'reader-one', isCurrent: () => true }).personalReady,
  ).toBe(true);

  if (pin.interaction.counts.state !== 'as-of' || pin.comments.state !== 'current')
    throw new Error('Expected selected count and activity witnesses');
  Object.assign(pin.interaction.counts.values, { upvote: 5 });
  Object.assign(pin.interaction.counts.source, { position: '13' });
  Object.assign(pin.comments.count, { value: 7 });
  Object.assign(pin.comments, { lastActivityAt: boardOpeningNow });
  Object.assign(pin.comments.source, { position: '14' });
  pin.actions.react = 'denied';

  const replacement = receiveBoardOpeningPage(response);
  expect(first.openingCards[threadId]!.interaction.counts).toMatchObject({
    values: { upvote: 0 },
    source: { position: '12' },
  });
  expect(first.openingCards[threadId]!.comments).toMatchObject({ count: { value: 0 }, source: { position: '10' } });
  expect(first.openingCards[threadId]!.actions.react).toBe('allowed');
  expect(replacement.openingCards[threadId]!.interaction.counts).toMatchObject({
    values: { upvote: 5 },
    source: { position: '13' },
  });
  expect(replacement.openingCards[threadId]!.comments).toMatchObject({
    count: { value: 7 },
    source: { position: '14' },
  });
  expect(replacement.openingCards[threadId]!.actions.react).toBe('denied');
  expect(replacement).not.toBe(first);
});
