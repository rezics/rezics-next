import { expect, test } from 'bun:test';
import { createHomeFeedWindow, type FeedInput, type HomeFeedResult } from '../src/features/pages/home-feed-read';

const initial: HomeFeedResult = { state: 'loading', code: 'loading' };
test('same-selection Next is one request; retiring a viewer discards late private pages', async () => {
  const calls: FeedInput[] = [];
  let resolve!: (page: HomeFeedResult) => void;
  let signal!: AbortSignal;
  const window = createHomeFeedWindow(initial, async (input, current) => {
    calls.push(input);
    signal = current;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const selection: FeedInput = {
    stream: 'home',
    kind: 'schema:Book',
    spaceId: 'space',
    ratingQuestionId: 'question',
    cursor: 'native-next',
  };
  const next = window.load(selection);
  await window.load({ ...selection });
  expect(calls).toEqual([selection]);
  window.clear();
  expect(signal.aborted).toBe(true);
  resolve({
    state: 'ready',
    page: {
      feedItems: [],
      next: 'private-next',
      asOf: '2026-11-03T00:00:00Z',
      sources: { discovery: 'ready', following: 'ready', continue: 'ready' },
    },
  });
  await next;
  expect(window.snapshot()).toEqual({ result: initial, busy: false, input: { stream: 'home' } });
});
