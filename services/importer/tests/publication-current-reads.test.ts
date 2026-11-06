import { expect, test } from 'bun:test';
import { createImportTransport } from '../src/import-client.ts';
import { createPublicBulkClient, GLOBAL_CONTEXT } from '../src/public-bulk-client.ts';

const original = '019a1b2c-3d4e-7f00-8a00-000000000001';
const canonical = '019a1b2c-3d4e-7f00-8a00-000000000002';

test('review and independent public publication reads bypass caches through current canonical redirects', async () => {
  const requests: Request[] = [];
  let revision = 1;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname.endsWith(original))
      return Response.json({ redirect: { from: original, to: canonical } }, { status: 308 });
    return Response.json({ subject: { id: canonical, revision } });
  }) as typeof fetch;
  const review = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'review-token',
    fetch: fetcher,
  });
  const anonymous = createPublicBulkClient({ origin: 'https://api.importer.test', fetch: fetcher });
  expect((await review.readReviewedSubject(original)).subject).toMatchObject({ id: canonical, revision: 1 });
  revision = 2;
  expect((await anonymous.readSubject(original)).subject).toMatchObject({ id: canonical, revision: 2 });
  revision = 3;
  expect((await anonymous.readSubject(original)).subject.revision).toBe(3);
  expect(requests).toHaveLength(6);
  for (const [index, request] of requests.entries()) {
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('authorization')).toBe(index < 2 ? 'Bearer review-token' : null);
    expect(new URL(request.url).searchParams.get('context')).toBe(index < 2 ? null : GLOBAL_CONTEXT);
  }
});
