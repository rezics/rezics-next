import { afterEach, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { readRatings } from '../src/features/pages/subject-ratings';
import { createRecordedKernelFetch } from '../src/kernel/fake';
import { GLOBAL, QUESTION, ratingsFixtures, routes, type RatingsFixtureName } from '../src/kernel/fake/ratings';

const subject = '00000000-0000-4000-8000-000000000001';
const fixtureNames = Object.keys(ratingsFixtures) as RatingsFixtureName[];

afterEach(() => {
  delete (globalThis as typeof globalThis & { __rezicsStoryContext?: { ratingsFixture?: string } })
    .__rezicsStoryContext;
});

async function answer(name: RatingsFixtureName, routeIndex: number, path: string, query = '') {
  (globalThis as typeof globalThis & { __rezicsStoryContext?: { ratingsFixture?: string } }).__rezicsStoryContext = {
    ratingsFixture: name,
  };
  const route = routes[routeIndex]!;
  const requestPath = `${path}${query}`;
  const match = route.path instanceof RegExp ? route.path.exec(path) : null;
  const handler = route.story!;
  return handler({ request: new Request(`http://kernel.local${requestPath}`), recordings: {}, match });
}

test.each(fixtureNames)('the %s state serves typed rating responses', async (name) => {
  const figures = ratingsFixtures[name].aggregate.figures;
  const population = figures.map((figure) => `population=${encodeURIComponent(figure.population)}`).join('&');
  const aggregate = await answer(name, 0, `/v1/subjects/${subject}/ratings`, `?question=${QUESTION}&${population}`);
  expect(aggregate).toMatchObject({ status: 200, question: QUESTION, subject, figures });

  const statistics = await answer(name, 1, `/v1/subjects/${subject}/source-statistics`);
  expect(statistics).toMatchObject({ status: 200, __responseBody: ratingsFixtures[name].statistics });

  const vote = await answer(name, 2, `/v1/subjects/${subject}/ratings/${QUESTION}/vote`);
  expect(vote).toMatchObject({ status: ratingsFixtures[name].voteStatus });
  if (ratingsFixtures[name].vote) expect(vote).toMatchObject(ratingsFixtures[name].vote);
});

test('the standard global population is part of the native rating fixtures', () => {
  expect(ratingsFixtures['subject-ratings-global'].aggregate.figures[0]?.population).toBe(GLOBAL);
});

test('the fake kernel keeps rating reads constant for empty and populated subjects', async () => {
  const fakeFetch = createRecordedKernelFetch({});
  for (const name of ['subject-ratings-imported', 'subject-ratings-global'] as const) {
    for (const authorization of [null, 'Bearer story-token']) {
      (globalThis as typeof globalThis & { __rezicsStoryContext?: { ratingsFixture?: string } }).__rezicsStoryContext =
        {
          ratingsFixture: name,
        };
      const paths: string[] = [];
      const client = createKernelClient('http://kernel.local', {
        fetch: (async (input, init) => {
          paths.push(new URL(input instanceof Request ? input.url : input.toString()).pathname);
          return fakeFetch(input, init);
        }) as typeof fetch,
      });
      expect(await readRatings(client, subject, authorization)).not.toBeNull();
      expect(paths.sort()).toEqual(
        [
          `/v1/subjects/${subject}/ratings`,
          `/v1/subjects/${subject}/source-statistics`,
          ...(authorization ? [`/v1/subjects/${subject}/ratings/${QUESTION}/vote`] : []),
        ].sort(),
      );
    }
  }
});
