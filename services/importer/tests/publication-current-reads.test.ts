import { expect, test } from 'bun:test';
import { createImportTransport } from '../src/import-client.ts';
import {
  admitSelectedSynopsisSupport,
  createPublicBulkClient,
  GLOBAL_CONTEXT,
  selectedSynopsisQueryFromPublic,
} from '../src/public-bulk-client.ts';

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

test('independent public selected-synopsis reads keep no-store, refuse redirects, and admit only redacted current slots', async () => {
  const statement = '019a1b2c-3d4e-7f00-8a00-000000000101';
  const document = '019a1b2c-3d4e-7f00-8a00-000000000202';
  const digest = 'c'.repeat(64);
  const release = `sha256:${'d'.repeat(64)}`;
  const subject = {
    id: original,
    context: GLOBAL_CONTEXT,
    release,
    statements: {
      'schema:abstract': [
        {
          id: statement,
          property: { id: 'schema:abstract', data_type: 'document' },
          value: { type: 'value', content: { document, digest, language: 'und' } },
          references: [],
        },
      ],
    },
  };
  const requests: URL[] = [];
  const client = createPublicBulkClient({
    origin: 'https://api.importer.test',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(url);
      expect(request.cache).toBe('no-store');
      expect(request.redirect).toBe('manual');
      if (url.pathname.endsWith(original) && url.searchParams.has('selectedSynopsis'))
        return Response.json({ redirect: { from: original, to: canonical } }, { status: 308 });
      const id = url.pathname.split('/').at(-1)!;
      return Response.json({
        subject: { ...subject, id },
        selectedSynopsis: {
          kind: 'matched',
          context: GLOBAL_CONTEXT,
          release,
          fact: {
            id: statement,
            rank: 'normal',
            property: { id: 'schema:abstract', data_type: 'document' },
            value: { type: 'somevalue' },
            qualifiers: [],
            references: [],
          },
        },
      });
    }) as typeof fetch,
  });
  const operands = selectedSynopsisQueryFromPublic({ subject } as never, statement)!;
  expect(JSON.parse(operands.query)).toEqual({
    statement,
    document,
    digest,
    language: 'und',
    context: GLOBAL_CONTEXT,
    release,
  });
  await expect(client.readSelectedSynopsis(original, operands.query)).rejects.toThrow(
    'Selected synopsis cannot follow a canonical redirect',
  );
  const current = await client.readSelectedSynopsis(canonical, operands.query);
  expect(admitSelectedSynopsisSupport(current, statement, operands.document)).toEqual({
    kind: 'matched',
    statement,
    context: GLOBAL_CONTEXT,
    release,
    references: [],
  });
  expect(
    admitSelectedSynopsisSupport(
      {
        ...current,
        selectedSynopsis: {
          kind: 'matched',
          context: GLOBAL_CONTEXT,
          release,
          fact: {
            id: statement,
            rank: 'normal',
            property: { id: 'schema:abstract', data_type: 'document' },
            value: { type: 'value', content: { document, digest, language: 'und' } },
            qualifiers: [],
            references: [],
          },
        },
      } as never,
      statement,
      operands.document,
    ),
  ).toEqual({ kind: 'unavailable' });
  expect(
    selectedSynopsisQueryFromPublic({ subject: { ...subject, statements: {} } } as never, statement),
  ).toBeUndefined();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.searchParams.get('selectedSynopsis')).toBe(operands.query);
});
