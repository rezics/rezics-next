import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { readCandidates } from '../src/subject/candidates';
import { readStatementConsent } from '../src/features/catalogue/statement-consent';
import { readProviderQueue } from '../src/features/import-review/provider-queue';
import { candidateFixture } from '../src/kernel/fake/subject-candidates';
import { providerQueueFixture } from '../src/kernel/fake/provider-review-queue';

test('candidate tombstones never enter review drafts and do not consume the native continuation', async () => {
  const fixture = candidateFixture();
  const tombstone = { id: crypto.randomUUID(), deleted: true };
  const client = createKernelClient('https://candidate.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/candidates')) return fixture.fetcher(request);
      return Response.json({
        candidates: url.searchParams.has('cursor') ? [tombstone] : [tombstone, fixture.candidate],
        adoption: { mode: 'replace', head: 7 },
        next: 'native-next',
      });
    },
  });
  const first = await readCandidates(client, 'Bearer reviewer', fixture.id, fixture.property);
  if (!first.ok || !first.page) throw new Error('Expected review page');
  expect(first.page).toEqual({
    candidates: [fixture.candidate],
    adoption: { mode: 'replace', head: 7 },
    next: 'native-next',
  });
  const continued = await readCandidates(client, 'Bearer reviewer', fixture.id, fixture.property, first.page.next!);
  if (!continued.ok || !continued.page) throw new Error('Expected continued page');
  expect(continued.page.candidates).toEqual([]);
  expect(continued.page.next).toBe('native-next');
});

test('a deleted consent target clears a lagging public body without reading withheld definitions', async () => {
  const fixture = candidateFixture();
  fixture.publicRead.subject.statements[fixture.property] = [fixture.candidate.statement];
  const calls: Request[] = [];
  const client = createKernelClient('https://candidate.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (!new URL(request.url).pathname.endsWith('/candidates')) return fixture.fetcher(request);
      return Response.json(
        { candidates: [{ id: fixture.candidate.id, deleted: true }], adoption: null, next: 'native-next' },
        { headers: { 'rezics-session-token': 'deleted-session' } },
      );
    },
  });
  expect(
    await readStatementConsent(client, 'Bearer owner', {
      id: fixture.id,
      property: fixture.property,
      candidate: fixture.candidate.id,
    }),
  ).toEqual({
    ok: true,
    candidate: null,
    terminal: true,
    disclosure: false,
    field: {},
    public: { state: 'pending' },
    next: null,
    session: 'deleted-session',
  });
  expect(calls).toHaveLength(2);
  expect(calls.every((request) => request.method === 'GET')).toBe(true);
  expect(
    calls.find((request) => !new URL(request.url).pathname.endsWith('/candidates'))?.headers.has('authorization'),
  ).toBe(false);
});

test('provider queues omit deleted payloads while retaining native freshness and continuation', async () => {
  const fixture = providerQueueFixture();
  if (fixture.initial.state !== 'ready') throw new Error('Expected queue page');
  const nativePage = fixture.initial.page;
  const client = createKernelClient('https://queue.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== '/v1/review-candidates') return fixture.native.fetcher(request);
      return Response.json({
        ...nativePage,
        candidates: [
          { subject: fixture.native.id, candidate: { id: crypto.randomUUID(), deleted: true }, adoption: null },
          ...nativePage.candidates,
        ],
        next: 'native-queue-next',
      });
    },
  });
  const result = await readProviderQueue(
    client,
    'Bearer reviewer',
    Promise.resolve({ types: {}, properties: {} }),
    fixture.scope,
  );
  if (result.state !== 'ready') throw new Error('Expected ready queue');
  expect(result.page).toEqual({ ...nativePage, next: 'native-queue-next' });
});
