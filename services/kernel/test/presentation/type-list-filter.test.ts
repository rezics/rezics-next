import { expect, test } from 'bun:test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { PageReadError, readPage } from '../../src/presentation/reads.ts';
import { profileSnapshot, ProfileInputError } from '../../src/presentation/profile-cache.ts';

const session = { ring: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) }, scope: 'anonymous' };
const filter = { statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } };
const document: CompositionDocument = {
  root: { props: {} },
  content: [
    {
      type: 'TypeList',
      props: {
        id: 'long-books',
        title: { en: 'Long books' },
        types: ['schema:Book'],
        filter,
        sort: 'name',
        limit: 24,
      },
    },
  ],
};

test('configured TypeList forwards its exact native filter, sort and per-node continuation', async () => {
  const cursor = 'opaque-native-cursor';
  const plan = planReads(platformRegistry, document, { subject: null, continuation: { node: 'long-books', cursor } });
  const body = { subjects: [{ id: 'native-hit' }], next: null, as_of: '2026-10-31T00:00:00.000Z' };
  const requests: unknown[] = [];
  const answer = await readPage({
    reads: plan.reads,
    session,
    incoming: new Request('http://kernel.test/v1/pages:read'),
    languages: ['en'],
    dispatch: async (request) => {
      expect(new URL(request.url).pathname).toBe('/v1/subjects:search');
      requests.push(await request.json());
      return Response.json(body);
    },
  });
  expect(requests).toEqual([
    {
      filter: { and: [{ type: { in: ['schema:Book'] } }, filter] },
      sort: 'name',
      limit: 24,
      cursor,
      languages: ['en'],
    },
  ]);
  expect(answer.results[plan.nodes['long-books']!]).toEqual({ status: 200, body });
});

test('an OwnerLeaf anywhere in the aggregate rejects the whole plan before I/O', async () => {
  let calls = 0;
  await expect(
    readPage({
      incoming: new Request('http://kernel.test/v1/pages:read'),
      session,
      reads: {
        valid: { kind: 'search', body: { filter: { type: { in: ['schema:Book'] } } } },
        invalid: { kind: 'search', body: { filter: { not: { owner: { presence: true } } } } },
      },
      dispatch: async () => {
        calls++;
        return Response.json({});
      },
    }),
  ).rejects.toBeInstanceOf(PageReadError);
  expect(calls).toBe(0);
  expect(() =>
    profileSnapshot({
      format: 'https://rezics.com/presentation/profile/1',
      generic: {
        ...document,
        content: [
          { type: 'TypeList', props: { ...document.content[0]!.props, filter: { owner: { presence: true } } } },
        ],
      },
      bases: [],
      types: [],
      routes: [],
    }),
  ).toThrow(ProfileInputError);
});
