import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type BoardPageResponse, type KernelClient } from '../src/index.ts';

type Card = BoardPageResponse['threads'][number];
type CurrentComments = Extract<Card['comments'], { state: 'current' }>;
type UnavailableComments = Extract<Card['comments'], { state: 'unavailable' }>;

expectTypeOf<CurrentComments['count']['value']>().toEqualTypeOf<number>();
expectTypeOf<CurrentComments['source']['position']>().toEqualTypeOf<string>();
expectTypeOf<UnavailableComments>().not.toBeNever();
expectTypeOf<BoardPageResponse['rankRefreshedAt']>().toEqualTypeOf<string | null>();
expectTypeOf<ReturnType<KernelClient['boards']>['page']['get']>().not.toBeNever();

test('the emitted Board page client preserves its selected reader and frontier', async () => {
  const boardId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const response = {} as BoardPageResponse;
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(response);
    }) as typeof fetch,
  });

  const result = await client.boards({ id: boardId }).page.get({
    query: { sort: 'hot', cursor: 'selected-frontier' },
    headers: { authorization: 'Bearer selected-reader' },
  });

  expect(result.data).toEqual(response);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toContain(`/v1/boards/${boardId}/page`);
  expect(new URL(requests[0]!.url).searchParams.get('sort')).toBe('hot');
  expect(new URL(requests[0]!.url).searchParams.get('cursor')).toBe('selected-frontier');
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer selected-reader');
});
