import { expect, mock, test } from 'bun:test';

// Focused server-action dependency injection, not native authorization evidence.
const request = new Request('https://site.example.test/en/settings');
let release: unknown;
let releaseReads = 0;
let subjects: { id: string; type: string; labels: Record<string, string>; summary: null }[] = [];
const queries: string[] = [];
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => ({
  createServerFn: () => ({
    validator(validate: (input: unknown) => unknown) {
      return {
        handler:
          (handle: (context: { data: unknown }) => unknown) =>
          ({ data }: { data: unknown }) =>
            handle({ data: validate(data) }),
      };
    },
  }),
}));
mock.module('@tanstack/react-start/server', () => ({ getRequest: () => request, setResponseHeader: () => {} }));
mock.module('../src/kernel/client', () => ({
  kernelClient: () => ({
    definitions: {
      active: { get: async () => ({ data: { digest: 'current' } }) },
      releases: () => ({
        get: async () => {
          releaseReads++;
          if (release instanceof Error) throw release;
          return { data: { digest: 'current', release } };
        },
      }),
    },
  }),
  requestLocale: () => 'en',
}));
mock.module('../src/session/request', () => ({
  prepareSession: async () => {},
  sessionSubject: () => 'alice',
  viewerCredential: () => 'Bearer private-viewer',
}));
mock.module('../src/search/suggestions', () => ({
  SUGGESTION_LIMIT: 8,
  readSubjectSuggestions: async (_client: unknown, query: { q: string }, credential: string, signal: AbortSignal) => {
    expect(credential).toBe('Bearer private-viewer');
    expect(signal.aborted).toBe(false);
    queries.push(query.q);
    return { subjects };
  },
}));
const { searchVerificationSubjects } = await import('../src/settings/verification-actions');
const { m } = await import('../src/paraglide/messages.js');
const candidate = (type: string) => ({ id: type, type, labels: { en: type }, summary: null });
const types = {
  'schema:Person': { bases: [] },
  'schema:Organization': { bases: [] },
  'schema:Book': { bases: [] },
  Author: { bases: ['schema:Person'] },
  Studio: { bases: ['schema:Organization'] },
};

test('required unavailable or malformed eligibility fails privately; real native empty remains empty', async () => {
  for (const unavailable of [
    new Error('private release URL and source failure'),
    undefined,
    { types: null },
    { types: {} },
    { types: { ...types, Author: null } },
    { types: { ...types, Author: { bases: 'schema:Person' } } },
    { types: { ...types, Author: { bases: [null, 'schema:Person'] } } },
    { types: { ...types, Author: { bases: ['missing', 'schema:Person'] } } },
    { types: { ...types, Author: { bases: ['Author', 'schema:Person'] } } },
  ]) {
    release = unavailable;
    subjects = [candidate('Author')];
    const before = queries.length;
    await expect(searchVerificationSubjects({ data: { query: 'Avery' } })).rejects.toThrow(
      m.settings_verification_search_failed(),
    );
    expect(queries.length - before).toBe(1);
  }
  release = new Error('private release unavailable');
  subjects = [];
  const before = releaseReads;
  expect(await searchVerificationSubjects({ data: { query: 'Unknown' } })).toEqual([]);
  expect(releaseReads).toBe(before);
});

test('retry uses current released roots and preserves Person/Organization filtering without result-detail reads', async () => {
  release = { types };
  subjects = [candidate('Author'), candidate('Studio'), candidate('schema:Book'), candidate('schema:Person')];
  const before = queries.length;
  const beforeRelease = releaseReads;
  expect(await searchVerificationSubjects({ data: { query: 'Avery' } })).toEqual([
    { id: 'Author', title: 'Author', type: m.settings_verification_person() },
    { id: 'Studio', title: 'Studio', type: m.settings_verification_organization() },
    { id: 'schema:Person', title: 'schema:Person', type: m.settings_verification_person() },
  ]);
  expect(queries.length - before).toBe(1);
  expect(releaseReads - beforeRelease).toBe(1);
  release = { types: { ...types, Author: { bases: ['schema:Book'] } } };
  subjects = [candidate('Author')];
  expect(await searchVerificationSubjects({ data: { query: 'Avery' } })).toEqual([]);
});

test('the server search validator preserves complete Unicode at the same input boundary', async () => {
  subjects = [];
  for (const [input, expected] of [
    [`${'a'.repeat(98)}😀extra`, `${'a'.repeat(98)}😀`],
    [`${'a'.repeat(99)}😀extra`, 'a'.repeat(99)],
    [`${'a'.repeat(99)}\uD83D`, 'a'.repeat(99)],
    ['😀'.repeat(51), '😀'.repeat(50)],
  ]) {
    await searchVerificationSubjects({ data: { query: input! } });
    expect(queries.at(-1)).toBe(expected);
    expect(queries.at(-1)!.isWellFormed()).toBe(true);
  }
});
