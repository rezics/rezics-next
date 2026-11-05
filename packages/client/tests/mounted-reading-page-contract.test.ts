import { expect, expectTypeOf, test } from 'bun:test';
import {
  createKernelClient,
  reviewedPersonRequests,
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

expectTypeOf<Routes['subjects']['$merge']['post']['response'][202]>().toHaveProperty('operation');
expectTypeOf<Routes['subjectIdentityOperations'][':id']['get']['response'][200]>().toHaveProperty('operation');

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
  await client.threads({ id })['reading-page'].get({ query: { cursor: 'next-page' }, headers });

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
    ['GET', `/v1/threads/${id}/reading-page`],
  ]);
  expect(new URL(sent[2]!.url).searchParams.get('board')).toBe(id);
  expect(await sent[5]!.json()).toMatchObject({ target: null, expectedRevision: '9007199254740993' });
  expect(sent[8]!.body).toBeNull();
  expect(sent[8]!.headers.get('idempotency-key')).toBe(headers['idempotency-key']);
  expect(sent[8]!.headers.get('accept-language')).toBe('ar-EG');
  expect(sent[11]!.body).toBeNull();
  expect(sent[11]!.headers.get('authorization')).toBe(headers.authorization);
  expect(sent[11]!.headers.get('idempotency-key')).toBe(headers['idempotency-key']);
  expect(new URL(sent[12]!.url).searchParams.get('cursor')).toBe('next-page');
});


test('reviewed Person uses the mounted original read, asynchronous merge and operation routes', async () => {
  const sent: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      sent.push(request);
      return Response.json({ operation: { id } }, { status: request.method === 'POST' ? 202 : 200 });
    }) as typeof fetch,
  });
  const requests = reviewedPersonRequests(client);
  await requests.read(id, { source: 'bangumi', externalId: 'person:8' });
  const endpoint = {
    subject: id, revision: 2, securityRevision: '9007199254740993', source: 'bangumi' as const,
    externalId: 'person:8', claimTransactionId: id, property: 'wdt:P6298' as const, value: '8',
  };
  const other = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const body = { subjects: [id, other] as [string, string], expectedIdentity: {
    endpoints: [endpoint, { ...endpoint, subject: other }] as [typeof endpoint, typeof endpoint],
  } };
  const response = await requests.merge(body, { headers: { 'idempotency-key': '"original-intent"' } });
  expect(response.status).toBe(202);
  expect(response.data).toEqual({ operation: { id } });
  await requests.operation(id);
  expect(new URL(sent[0]!.url).searchParams.get('reviewIdentityExternalId')).toBe('person:8');
  expect(sent[0]!.redirect).toBe('manual');
  expect(new URL(sent[1]!.url).pathname).toBe('/v1/subjects:merge');
  expect(await sent[1]!.json()).toEqual(body);
  expect(new URL(sent[2]!.url).pathname).toBe(`/v1/subjectIdentityOperations/${id}`);
});
