import { beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as start from '../.storybook/react-start';
import type { EditionMetadata } from '../src/content-editions/edition-api';
import { configuredPriceExample, creatorOfferFixture } from '../src/kernel/fake/creator-offers';
import * as sessionState from '../src/session/state';

const edition: EditionMetadata = {
  editionId: '019a2100-0000-7000-8000-000000000001',
  editionRevision: '019a2100-0000-7000-8000-000000000002',
  state: 'published',
  targetSubjectId: creatorOfferFixture.targetSubjectId,
  creatorAccountId: '019a2100-0000-7000-8000-000000000003',
  revisionId: '019a2100-0000-7000-8000-000000000004',
  sha256: 'a'.repeat(64),
  licence: 'CC-BY-4.0',
};
const request = () =>
  new Request('https://site.test/en/creator/offers', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let currentRequest = request();
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let preparations = 0;
let identities = 0;
let responseHeaders = new Headers();

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
mock.module('cloudflare:workers', () => ({
  env: {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          preparations++;
          if (preparation !== 'active') return { status: preparation };
          // A second preparation would refuse: a composed read must use the first result throughout.
          preparation = 'absent';
          return {
            status: 'active',
            accessToken: `current-seller-${preparations}`,
            subject: edition.creatorAccountId,
            csrfToken: 'private-csrf',
          };
        },
        signedIn: async () => {
          identities++;
          return { signedIn: true, subject: edition.creatorAccountId, csrfToken: 'private-csrf' };
        },
      }),
    },
  },
}));
const { readCreatorOfferEditor, readCreatorOffers } = await import('../src/routes/-creator-offer-read');
const { viewerCredential } = await import('../src/session/request');

beforeEach(() => {
  currentRequest = request();
  preparation = 'active';
  preparations = 0;
  identities = 0;
  responseHeaders = new Headers();
});

function nativeResponse(call: Request): Response {
  switch (new URL(call.url).pathname) {
    case '/v1/platform/exposure':
      return Response.json({ admitted: ['selling'] });
    case `/v1/contentEditions/${edition.editionId}`:
      return Response.json(edition);
    case '/v1/offers':
      return Response.json({ offers: [creatorOfferFixture], next: 'signed-next' });
    case '/v1/commerceMoney':
      return Response.json(configuredPriceExample);
    default:
      throw new Error(`Unexpected private read: ${call.url}`);
  }
}

test('actual creator editor and list refuse retained request authority before any private child or identity read', async () => {
  const calls: Request[] = [];
  const identity = spyOn(sessionState, 'readSessionIdentity');
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    return nativeResponse(call);
  });
  try {
    // The real preparation caches authority on this Request; its next real preparation returns absent.
    expect((await readCreatorOfferEditor({ data: {} })).editor).toEqual({ kind: 'choose-edition' });
    expect(viewerCredential(currentRequest)).toBe('Bearer current-seller-1');
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/platform/exposure']);
    calls.length = 0;

    expect(await readCreatorOfferEditor({ data: { contentEditionId: edition.editionId } })).toEqual({
      editor: { kind: 'denied' },
      csrfToken: '',
      createKey: expect.any(String),
      selling: false,
    });
    expect(await readCreatorOffers({ data: {} })).toEqual({
      page: { kind: 'denied' },
      schema: null,
      csrfToken: '',
      selling: false,
      keys: {},
    });
    expect(viewerCredential(currentRequest)).toBe('Bearer current-seller-1');
    expect(preparations).toBe(3);
    expect(calls).toEqual([]);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(identities).toBe(1);

    preparation = 'unavailable';
    expect((await readCreatorOfferEditor({ data: { contentEditionId: edition.editionId } })).editor).toEqual({
      kind: 'unavailable',
    });
    expect((await readCreatorOffers({ data: {} })).page).toEqual({ kind: 'unavailable' });
    expect(preparations).toBe(5);
    expect(calls).toEqual([]);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(responseHeaders.get('x-robots-tag')).toBe('noindex, nofollow');
  } finally {
    transport.mockRestore();
    identity.mockRestore();
  }
});

test('healthy default creator reads share one current credential and native private transport, including explicit headers without cookies', async () => {
  const calls: Request[] = [];
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    return nativeResponse(call);
  });
  try {
    const editor = await readCreatorOfferEditor({ data: { contentEditionId: edition.editionId } });
    expect(editor).toEqual({
      editor: { kind: 'ready', edition, schema: configuredPriceExample },
      csrfToken: 'private-csrf',
      createKey: expect.any(String),
      selling: true,
    });
    currentRequest = request();
    preparation = 'active';
    const list = await readCreatorOffers({ data: { cursor: 'signed/current+page' } });
    expect(list).toEqual({
      page: { kind: 'ready', offers: [creatorOfferFixture], next: 'signed-next' },
      schema: configuredPriceExample,
      csrfToken: 'private-csrf',
      selling: true,
      keys: { [creatorOfferFixture.id]: { reprice: expect.any(String), delist: expect.any(String) } },
    });
    expect(preparations).toBe(2);
    expect(identities).toBe(2);
    expect(
      calls.map((call) => [new URL(call.url).pathname, Object.fromEntries(new URL(call.url).searchParams)]),
    ).toEqual([
      ['/v1/platform/exposure', {}],
      [`/v1/contentEditions/${edition.editionId}`, {}],
      ['/v1/commerceMoney', {}],
      ['/v1/platform/exposure', {}],
      ['/v1/offers', { limit: '20', cursor: 'signed/current+page' }],
      ['/v1/commerceMoney', {}],
    ]);
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual([
      ...Array(3).fill('Bearer current-seller-1'),
      ...Array(3).fill('Bearer current-seller-2'),
    ]);

    currentRequest = new Request('https://site.test/en/creator/offers', {
      headers: { authorization: 'Bearer explicit-seller' },
    });
    expect((await readCreatorOfferEditor({ data: { contentEditionId: edition.editionId } })).editor).toEqual({
      kind: 'ready',
      edition,
      schema: configuredPriceExample,
    });
    expect((await readCreatorOffers({ data: {} })).page).toEqual({
      kind: 'ready',
      offers: [creatorOfferFixture],
      next: 'signed-next',
    });
    expect(preparations).toBe(2);
    expect(identities).toBe(2);
    expect(calls).toHaveLength(12);
    expect(calls.slice(6).every((call) => call.headers.get('authorization') === 'Bearer explicit-seller')).toBe(true);
    expect(
      calls.every((call) => call.method === 'GET' && call.cache === 'no-store' && call.redirect === 'manual'),
    ).toBe(true);
    expect(calls.every((call) => new URL(call.url).origin === 'https://kernel.test')).toBe(true);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(responseHeaders.get('x-robots-tag')).toBe('noindex, nofollow');
  } finally {
    transport.mockRestore();
  }
});
