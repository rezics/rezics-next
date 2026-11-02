import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';

const stamp = '2026-01-01T00:00:00.000Z';
const first = '123e4567-e89b-12d3-a456-426614174000';
const second = '123e4567-e89b-12d3-a456-426614174001';
const sentinel = 'Type-label-sentinel';
const matching = {
  id: first,
  type: 'schema:Book',
  types: ['schema:Book'],
  label: null,
  creativeWork: true,
  cover: null,
};
let native: unknown = { subjects: [], as_of: stamp };
let release: { types: Record<string, Record<string, string>> } | Error = new Error('missing release');

mock.module('../src/kernel/client.ts', () => ({
  requestLocale: () => 'en',
  kernelClient: () =>
    createKernelClient('http://kernel.local', {
      fetch: async () => Response.json(native),
    }),
}));
mock.module('../src/subject/definitions.ts', () => ({
  readRelease: async () => {
    if (release instanceof Error) throw release;
    return release;
  },
}));

const { suggestionResponse } = await import('../src/search/suggestions');

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'schema:Book',
  labels: { en: 'Prince' },
  summary: null,
  ...extra,
});
const page = (subjects: unknown[], extra: Record<string, unknown> = {}) => ({ subjects, as_of: stamp, ...extra });

async function admit(limit = 2) {
  return suggestionResponse(new Request(`https://site.test/api/search/suggestions?q=Prince&limit=${limit}`), {});
}

async function unavailable(value: unknown) {
  native = value;
  const response = await admit();
  expect(response.status).toBe(502);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = await response.json();
  expect(body).toMatchObject({ code: 'dependency_unavailable' });
  expect(JSON.stringify(body)).not.toContain(sentinel);
}

test('malformed native suggestion pages stay unavailable and never receive type labels', async () => {
  release = { types: { 'schema:Book': { en: sentinel } } };
  for (const value of [
    null,
    { as_of: stamp },
    { subjects: { id: first }, as_of: stamp },
    { subjects: [row(first)], as_of: 'yesterday' },
    page(
      Array.from({ length: 11 }, (_, index) =>
        row(`123e4567-e89b-12d3-a456-4266141740${String(index).padStart(2, '0')}`),
      ),
    ),
    page([row(first), row(first.toUpperCase())]),
    page([row(first, { summary: { ...matching, id: second } })]),
    page([row(first, { summary: { ...matching, type: 'schema:Person' } })]),
    page([row(first), { id: second, type: 'schema:Book' }]),
  ])
    await unavailable(value);
});

test('a trailing malformed native row is refused before truncation or type-label enrichment', async () => {
  release = { types: { 'schema:Book': { en: sentinel } } };
  native = page([row(first), { id: second, type: 'schema:Book', labels: { en: 'Fox' } }]);
  const response = await admit(1);
  const body = await response.json();
  expect(response.status).toBe(502);
  expect(body).toMatchObject({ code: 'dependency_unavailable' });
  expect(JSON.stringify(body)).not.toContain(sentinel);
});

test('valid empty, optional metadata and a missing definitions release stay ready without manufactured labels', async () => {
  release = new Error('missing release');
  native = page([]);
  const empty = await (await admit()).json();
  expect(empty).toEqual({ subjects: [], as_of: stamp, types: {} });
  native = page([
    row(first, {
      summary: matching,
      facts: { published: [{ kind: 'time', year: 1943 }] },
    }),
  ]);
  const optional = await (await admit(1)).json();
  expect(optional).toEqual({
    subjects: [row(first, { summary: matching, facts: { published: [{ kind: 'time', year: 1943 }] } })],
    as_of: stamp,
    types: {},
  });
  native = page([row(first), row(second)]);
  const truncated = await (await admit(1)).json();
  expect(truncated.subjects.map((subject: { id: string }) => subject.id)).toEqual([first]);
  expect(truncated.types).toEqual({});
  release = { types: { 'schema:Book': { en: 'Book' } } };
  native = page([row(first)]);
  expect((await (await admit()).json()).types).toEqual({ 'schema:Book': { en: 'Book' } });
});
