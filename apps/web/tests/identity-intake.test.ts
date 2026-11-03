import { expect, test } from 'bun:test';
import { problem } from '../src/media/kernel';
import {
  identityIntakeResponse,
  type IdentityIntakeRuntime,
} from '../src/features/catalogue/identity-intake-server';
import { parseIdentityIntakeRequest } from '../src/features/catalogue/identity-intake';

const query = new URLSearchParams({
  q: '  The   Book ',
  language: 'ja',
  type: 'schema:Book',
  release: 'release-1',
  locale: 'en',
  generation: '4',
});

function makeRuntime(readSuggestions: IdentityIntakeRuntime['readSuggestions'], digest = 'release-1') {
  let searchCalls = 0;
  const runtime = {
    prepareSession: async () => false,
    carriesSession: () => false,
    viewerCredential: () => 'Bearer current-reader',
    readTypeDescriptor: async (typeId: string) => ({
      ok: true,
      descriptor: {
        typeId,
        label: 'Book',
        language: 'en',
        description: null,
        descriptionLanguage: null,
        definition: { properties: ['schema:datePublished'] },
        releaseDigest: digest,
        properties: { 'schema:datePublished': { labels: { en: 'Published' } } },
      },
    }),
    readSuggestions: async (...args: Parameters<IdentityIntakeRuntime['readSuggestions']>) => {
      searchCalls++;
      return readSuggestions(...args);
    },
  } as unknown as IdentityIntakeRuntime;
  return { runtime, searchCalls: () => searchCalls };
}

test('intake input is normalized and rejects unsupported cursor or repeated binding fields', () => {
  expect(parseIdentityIntakeRequest(query)).toEqual({
    q: 'The Book',
    language: 'ja',
    typeId: 'schema:Book',
    releaseDigest: 'release-1',
    locale: 'en',
    generation: 4,
  });
  const cursor = new URLSearchParams(query);
  cursor.set('cursor', 'next');
  expect(parseIdentityIntakeRequest(cursor)).toBeNull();
  const repeatedType = new URLSearchParams(query);
  repeatedType.append('type', 'schema:Movie');
  expect(parseIdentityIntakeRequest(repeatedType)).toBeNull();
});

test('one private read returns current suggestions, viewer and unknown create authority together', async () => {
  const subjectId = '65f28bc6-dc49-4a5b-bb3c-b5b116739aaf';
  let seenQuery: Parameters<IdentityIntakeRuntime['readSuggestions']>[0] | undefined;
  let seenCredential: string | null | undefined;
  const { runtime } = makeRuntime(async (suggestionQuery, credential) => {
    seenQuery = suggestionQuery;
    seenCredential = credential;
    return {
      as_of: '2026-11-03T00:00:00.000Z',
      subjects: [
        {
          id: subjectId,
          type: 'schema:Book',
          labels: { en: 'A Book', ja: '本' },
          summary: {
            id: subjectId,
            type: 'schema:Book',
            types: ['schema:Book'],
            label: { value: 'A Book', language: 'en' },
            creativeWork: true,
            cover: null,
          },
        },
      ],
    } as never;
  });
  const request = new Request(`https://site.test/api/catalogue/identity-intake?${query}`);
  const response = await identityIntakeResponse(request, {}, runtime);
  const page = await response.json();

  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.status).toBe(200);
  expect(page).toMatchObject({
    binding: { q: 'The Book', language: 'ja', typeId: 'schema:Book', releaseDigest: 'release-1', generation: 4 },
    status: 'ready',
    viewer: { state: 'signed-in' },
    actions: { openExisting: true, continueWithResults: true, createAuthority: 'unknown' },
    results: [{ id: subjectId, type: 'schema:Book', labels: [{ language: 'ja', value: '本' }, { language: 'en', value: 'A Book' }] }],
  });
  expect(seenCredential).toBe('Bearer current-reader');
  expect(seenQuery).toEqual({
    q: 'The Book',
    limit: 8,
    languages: ['ja'],
    filter: JSON.stringify({ type: { in: ['schema:Book'] } }),
  });
});

test('Search failure stays unavailable and a changed release avoids a stale search', async () => {
  const failed = makeRuntime(async () => {
    throw problem(503, 'dependency_unavailable', 'Search unavailable');
  });
  const request = new Request(`https://site.test/api/catalogue/identity-intake?${query}`);
  const unavailable = await (await identityIntakeResponse(request, {}, failed.runtime)).json();
  expect(unavailable).toMatchObject({
    status: 'unavailable',
    results: [],
    actions: { continueWithResults: false, continueUnverified: true, retry: true },
  });
  expect(failed.searchCalls()).toBe(1);

  const stale = makeRuntime(async () => ({ subjects: [], as_of: '2026-11-03T00:00:00.000Z' } as never), 'release-2');
  const stalePage = await (await identityIntakeResponse(request, {}, stale.runtime)).json();
  expect(stalePage).toMatchObject({ status: 'stale', results: [], actions: { retry: true } });
  expect(stale.searchCalls()).toBe(0);
});
