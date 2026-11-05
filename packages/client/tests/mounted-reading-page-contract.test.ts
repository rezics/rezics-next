import { expect, expectTypeOf, test } from 'bun:test';
import {
  createKernelClient,
  type BoardPageResponse,
  type Kernel,
  type KernelClient,
  type ReadingPageResponse,
} from '@rezics/client';

type Routes = Kernel['~Routes']['v1'];
expectTypeOf<BoardPageResponse['pinRevision']>().toEqualTypeOf<string>();
expectTypeOf<ReadingPageResponse>().toHaveProperty('documentMedia');
expectTypeOf<ReadingPageResponse>().toHaveProperty('mentions');
expectTypeOf<ReadingPageResponse>().toHaveProperty('reviewContext');
expectTypeOf<ReadingPageResponse>().toHaveProperty('conversationActivity');
expectTypeOf<Routes['subjects'][':id']['threads']['get']['query']['board']>().toEqualTypeOf<string | undefined>();
expectTypeOf<Routes['subjects'][':id']['threads']['get']['response'][200]>().toHaveProperty('entry');
expectTypeOf<Routes['libraryYearlyCompletionGoal']['put']['response'][200]['revision']>().toEqualTypeOf<string>();
expectTypeOf<Routes['collections'][':collectionId']['members']['get']['response'][200]>().toHaveProperty('viewerFacts');

const id = '019a1b2c-3d4e-7f00-8a00-000000000001';

test('installed public root exposes the mounted reading, review, rating and shelf callables', async () => {
  const sent: Request[] = [];
  const client: KernelClient = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      sent.push(new Request(input, init));
      return Response.json({});
    }) as typeof fetch,
  });
  const headers = {
    authorization: 'Bearer viewer',
    'idempotency-key': '"original-intent"',
    'Accept-Language': 'ar-EG',
  };
  await client.boards({ id }).page.get();
  await client.boards({ id })['pin-advice'].post({ selected: [], pinRevision: '0' }, { headers });
  await client.subjects({ id }).threads.get({ query: { place: id, kind: 'discussion', board: id } });
  await client.realms({ realmId: id })['review-destinations'].get({ query: { subjectId: id } });
  await client.libraryYearlyCompletionGoal.get({ query: { year: 2026 } });
  await client.libraryYearlyCompletionGoal.put(
    { year: 2026, metric: 'completed_consumption_occurrences', target: null, expectedRevision: '9007199254740993' },
    { headers },
  );
  await client.libraryEntries.get({ query: { orderBy: 'priority', direction: 'desc' }, headers });
  await client.libraryEntries.get({ query: { orderBy: 'title', direction: 'asc' }, headers });
  await client.libraryShelfTitlePreparation.post(undefined, { headers });
  await client.me['rating-votes'].get({ query: { cursor: 'selected-page' }, headers });
  await client.collections({ collectionId: id }).members.get({ query: { view: 'FULL' }, headers });
  await client.libraryExports.post(undefined, { headers });

  expect(sent.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ['GET', `/v1/boards/${id}/page`],
    ['POST', `/v1/boards/${id}/pin-advice`],
    ['GET', `/v1/subjects/${id}/threads`],
    ['GET', `/v1/realms/${id}/review-destinations`],
    ['GET', '/v1/libraryYearlyCompletionGoal'],
    ['PUT', '/v1/libraryYearlyCompletionGoal'],
    ['GET', '/v1/libraryEntries'],
    ['GET', '/v1/libraryEntries'],
    ['POST', '/v1/libraryShelfTitlePreparation'],
    ['GET', '/v1/me/rating-votes'],
    ['GET', `/v1/collections/${id}/members`],
    ['POST', '/v1/libraryExports'],
  ]);
  expect(new URL(sent[2]!.url).searchParams.get('board')).toBe(id);
  expect(await sent[5]!.json()).toMatchObject({ target: null, expectedRevision: '9007199254740993' });
  expect(sent[8]!.body).toBeNull();
  expect(sent[8]!.headers.get('idempotency-key')).toBe(headers['idempotency-key']);
  expect(sent[8]!.headers.get('accept-language')).toBe('ar-EG');
  expect(sent[11]!.body).toBeNull();
  expect(sent[11]!.headers.get('authorization')).toBe(headers.authorization);
  expect(sent[11]!.headers.get('idempotency-key')).toBe(headers['idempotency-key']);
});
