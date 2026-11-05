import { afterEach, expect, test } from 'bun:test';
import {
  creatorOffersLaterEmptyContinuationCursor,
  creatorOffersLaterEmptyCursor,
  creatorOfferFixture,
  delistedCreatorOfferFixture,
  routes,
  setCreatorOffersStory,
} from '../src/kernel/fake/creator-offers';

const offersRoute = routes.find((route) => route.method === 'GET' && route.path === '/v1/offers');

function asPage(response: unknown): { status: number; offers: unknown[]; next: string | null } {
  if (!response || typeof response !== 'object') throw new Error('Expected an offer response');
  return response as { status: number; offers: unknown[]; next: string | null };
}

async function requestPage(url: URL) {
  if (!offersRoute?.story) throw new Error('Expected the story offer route');
  return asPage(await offersRoute.story({ request: new Request(url), recordings: {}, match: null }));
}

afterEach(() => setCreatorOffersStory());

test('the selected later-empty route follows only its supplied cursor and retains the empty response continuation', async () => {
  setCreatorOffersStory('later-empty');

  const first = await requestPage(new URL('https://site.test/v1/offers'));
  expect(first).toMatchObject({
    status: 200,
    offers: expect.arrayContaining([expect.objectContaining({ id: creatorOfferFixture.id })]),
    next: creatorOffersLaterEmptyCursor,
  });

  const suppliedAddress = new URL('https://site.test/v1/offers');
  suppliedAddress.searchParams.set('cursor', first.next!);
  const laterEmpty = await requestPage(suppliedAddress);
  expect(laterEmpty).toEqual({
    status: 200,
    offers: [],
    next: creatorOffersLaterEmptyContinuationCursor,
  });

  const arbitraryAddress = new URL('https://site.test/v1/offers?cursor=other-cursor');
  expect(await requestPage(arbitraryAddress)).toMatchObject({
    status: 200,
    offers: [expect.objectContaining({ id: delistedCreatorOfferFixture.id })],
    next: null,
  });

  setCreatorOffersStory();
  expect(await requestPage(suppliedAddress)).toMatchObject({
    status: 200,
    offers: [expect.objectContaining({ id: delistedCreatorOfferFixture.id })],
    next: null,
  });
});
