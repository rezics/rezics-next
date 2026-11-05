import { expect, test } from 'bun:test';
import { problem } from '../src/media/kernel';
import {
  identityIntakeResponse,
  observeCreateEligibility,
  type IdentityIntakeRuntime,
} from '../src/features/catalogue/identity-intake-server';
import {
  allowedCreateAuthority,
  parseIdentityIntakeRequest,
  type CreateAuthority,
} from '../src/features/catalogue/identity-intake';

const query = new URLSearchParams({
  q: '  The   Book ',
  language: 'ja',
  type: 'schema:Book',
  release: 'release-1',
  locale: 'en',
  generation: '4',
});

function makeRuntime(
  readSuggestions: IdentityIntakeRuntime['readSuggestions'],
  digest = 'release-1',
  options: {
    credential?: string | null;
    eligibility?: CreateAuthority;
    readCreateEligibility?: IdentityIntakeRuntime['readCreateEligibility'];
  } = {},
) {
  let searchCalls = 0;
  let eligibilityCalls = 0;
  const runtime = {
    prepareSession: async () => false,
    carriesSession: () => false,
    viewerCredential: () => ('credential' in options ? options.credential : 'Bearer current-reader'),
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
    readCreateEligibility: async (...args: Parameters<IdentityIntakeRuntime['readCreateEligibility']>) => {
      eligibilityCalls++;
      if (options.readCreateEligibility) return options.readCreateEligibility(...args);
      return options.eligibility ?? allowedCreateAuthority;
    },
  } as IdentityIntakeRuntime;
  return { runtime, searchCalls: () => searchCalls, eligibilityCalls: () => eligibilityCalls };
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

test('one private read returns current suggestions, viewer and current create authority together', async () => {
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
    actions: { openExisting: true, continueWithResults: true, createAuthority: allowedCreateAuthority },
    results: [
      {
        id: subjectId,
        type: 'schema:Book',
        labels: [
          { language: 'ja', value: '本' },
          { language: 'en', value: 'A Book' },
        ],
      },
    ],
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

  const stale = makeRuntime(async () => ({ subjects: [], as_of: '2026-11-03T00:00:00.000Z' }) as never, 'release-2');
  const stalePage = await (await identityIntakeResponse(request, {}, stale.runtime)).json();
  expect(stalePage).toMatchObject({ status: 'stale', results: [], actions: { retry: true } });
  expect(stale.searchCalls()).toBe(0);
});

test('suggestion failure keeps a current allowed create observation', async () => {
  const failed = makeRuntime(async () => {
    throw problem(503, 'dependency_unavailable', 'Search unavailable');
  });
  const page = await (
    await identityIntakeResponse(
      new Request(`https://site.test/api/catalogue/identity-intake?${query}`),
      {},
      failed.runtime,
    )
  ).json();
  expect(page).toMatchObject({
    status: 'unavailable',
    results: [],
    actions: { createAuthority: allowedCreateAuthority, continueUnverified: true, retry: true },
  });
  expect(failed.eligibilityCalls()).toBe(1);
});

test('successful suggestions cannot grant creation when the parent action is absent', async () => {
  const refused = makeRuntime(async () => ({ subjects: [], as_of: '2026-11-03T00:00:00.000Z' }) as never, 'release-1', {
    eligibility: { state: 'refused', reason: 'permission' },
  });
  const page = await (
    await identityIntakeResponse(
      new Request(`https://site.test/api/catalogue/identity-intake?${query}`),
      {},
      refused.runtime,
    )
  ).json();
  expect(page).toMatchObject({
    status: 'empty',
    actions: { createAuthority: { state: 'refused', reason: 'permission' }, continueWithResults: true },
  });
});

test('a guest visit reports guest eligibility without treating the empty session as a permission denial', async () => {
  const guest = makeRuntime(async () => ({ subjects: [], as_of: '2026-11-03T00:00:00.000Z' }) as never, 'release-1', {
    credential: null,
    eligibility: { state: 'guest' },
  });
  const page = await (
    await identityIntakeResponse(
      new Request(`https://site.test/api/catalogue/identity-intake?${query}`),
      {},
      guest.runtime,
    )
  ).json();
  expect(page).toMatchObject({
    viewer: { state: 'signed-out' },
    actions: { createAuthority: { state: 'guest' } },
  });
});

test('parent viewerActions map gate, suspension, dependency and empty permission honestly', async () => {
  const post = async (result: { status: number; data?: unknown; error?: { value?: unknown } }) =>
    observeCreateEligibility(
      { viewerActions: { post: async () => result } } as never,
      'Bearer current-reader',
      'signed-in',
    );
  expect(await observeCreateEligibility({} as never, null, 'signed-out')).toEqual({ state: 'guest' });
  expect(
    await post({
      status: 200,
      data: {
        resources: [
          {
            type: 'semantic.context',
            id: '00000000-0000-8000-8000-000000000000',
            viewerActions: [{ action: 'subject:create', operations: ['subject.create'] }],
          },
        ],
      },
    }),
  ).toEqual(allowedCreateAuthority);
  expect(
    await post({
      status: 200,
      data: {
        resources: [{ type: 'semantic.context', id: '00000000-0000-8000-8000-000000000000', viewerActions: [] }],
      },
    }),
  ).toEqual({ state: 'refused', reason: 'permission' });
  expect(await post({ status: 403, error: { value: { code: 'platform_closed' } } })).toEqual({
    state: 'refused',
    reason: 'gate',
  });
  expect(await post({ status: 403, error: { value: { code: 'account_suspended' } } })).toEqual({
    state: 'refused',
    reason: 'suspended',
  });
  expect(await post({ status: 503, error: { value: { code: 'dependency_unavailable' } } })).toEqual({
    state: 'unknown',
    reason: 'dependency',
  });
  expect(
    await post({
      status: 200,
      data: {
        resources: [{ type: 'semantic.context', id: '00000000-0000-8000-8000-000000000000', error: 'not_found' }],
      },
    }),
  ).toEqual({ state: 'unknown', reason: 'unavailable' });
});
