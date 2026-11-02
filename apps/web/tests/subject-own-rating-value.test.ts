import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { preparedRatingReader, QUESTION, readOwnRating } from '../src/features/pages/subject-ratings';

const authorization = 'Bearer own-rating-reader';
const request = () => new Request('https://site.test', { headers: { authorization } });
function fixture(body: unknown, status = 200) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, calls };
}

test('missing or malformed successful own votes stay unavailable, including non-native null units', async () => {
  for (const body of [
    undefined, null, {}, [], 1, { units: null }, { units: '8' }, { units: true },
    { units: 1.5 }, { units: Number.MAX_SAFE_INTEGER + 1 }, { units: Infinity },
  ]) {
    const { client } = fixture(body);
    expect((await readOwnRating(client, request(), {}, 'subject')).kind).toBe('unavailable');
  }
});

test('native absence stays ready/null and integer votes need no scale or extra read', async () => {
  const reader = await preparedRatingReader(request(), authorization);
  for (const units of [-1, 0, 17, 21, Number.MAX_SAFE_INTEGER, null]) {
    const { client, calls } = fixture(units === null ? undefined : { units }, units === null ? 404 : 200);
    expect(await readOwnRating(client, request(), {}, 'subject', reader)).toEqual({ reader, kind: 'ready', units });
    expect(calls.map((call) => [new URL(call.url).pathname, call.headers.get('authorization')])).toEqual([
      [`/v1/subjects/subject/ratings/${QUESTION}/vote`, authorization],
    ]);
  }
});

test('reader mismatches and missing credentials still fence personal reads before transport', async () => {
  const { client, calls } = fixture({ units: 17 });
  const reader = await preparedRatingReader(request(), authorization);
  for (const expectedReader of [null, 'another-reader'])
    expect(await readOwnRating(client, request(), {}, 'subject', expectedReader)).toEqual({ reader, kind: 'unavailable' });
  expect(await readOwnRating(client, new Request('https://site.test'), {}, 'subject')).toEqual({
    reader: null, kind: 'unavailable',
  });
  expect(calls).toHaveLength(0);
});
