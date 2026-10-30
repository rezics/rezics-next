import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionEnv } from '../src/session/client';
import type { EditionMetadata } from '../src/content-editions/edition-api';
import {
  createNativeCreatorEditionsApi,
  creatorEditionsSearch,
  loadCreatorEditions,
  unavailableCreatorEditionsApi,
  type CreatorEditionsApi,
} from '../src/content-editions/creator-editions';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test/en/editions'),
  setResponseHeader: () => {},
}));
const { loadSessionCreatorEditions } = await import('../src/content-editions/creator-editions-read');
const { CreatorEditionsView } = await import('../src/content-editions/creator-editions-view');
const { isSignedInPath } = await import('../src/session/guard');
const { localizeHref } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');

const draft: EditionMetadata = {
  editionId: '0192f3a0-6c1e-7b2a-9d4e-000000000080',
  editionRevision: '1',
  state: 'draft',
  targetSubjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000020',
  creatorAccountId: '0192f3a0-6c1e-7b2a-9d4e-000000000090',
  revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  sha256: 'a'.repeat(64),
  licence: 'CC-BY-SA-4.0',
};
const published: EditionMetadata = {
  ...draft,
  editionId: '0192f3a0-6c1e-7b2a-9d4e-000000000081',
  editionRevision: '2',
  state: 'published',
};
const withdrawn: EditionMetadata = {
  ...draft,
  editionId: '0192f3a0-6c1e-7b2a-9d4e-000000000082',
  editionRevision: '3',
  state: 'withdrawn',
};
const api = (data: unknown, status = 200): CreatorEditionsApi => ({ get: async () => ({ status, data }) });
const load = (source: CreatorEditionsApi, cursor?: string) =>
  loadCreatorEditions(source, draft.creatorAccountId, 'Bearer current-creator', cursor ? { cursor } : {});

test('Creator editions return journey with real native draft and publication destinations', async () => {
  const page = await load(api({ editions: [draft, published, withdrawn], next: null }));
  const html = renderToStaticMarkup(createElement(CreatorEditionsView, { page }));
  for (const edition of [draft, published, withdrawn]) {
    expect(html).toContain(edition.editionId);
    expect(html).toContain(edition.revisionId);
    expect(html).toContain(edition.licence);
  }
  expect(html).toContain(`href="${localizeHref(`/editions/new?editionId=${draft.editionId}`)}"`);
  expect(html).toContain(`href="${localizeHref(`/editions/${published.editionId}`)}"`);
  expect(html).toContain(`href="${localizeHref(`/creator/offers/new?editionId=${published.editionId}`)}"`);
  for (const edition of [draft, withdrawn]) {
    expect(html).not.toContain(`/creator/offers/new?editionId=${edition.editionId}`);
    expect(html).not.toContain(`href="${localizeHref(`/editions/${edition.editionId}`)}"`);
  }
  expect(html).not.toContain('sha256');
  expect(html).not.toContain('sellerActor');
});

test('one exact native page carries current credential, no-store and the unchanged continuation', async () => {
  const calls: Request[] = [];
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Response.json({ editions: [], next: 'opaque-next/+=' });
    },
    { preconnect() {} },
  );
  const native = createNativeCreatorEditionsApi('https://kernel.test', fetcher);
  expect(await load(native, 'opaque-current/+=')).toEqual({ kind: 'ready', editions: [], next: 'opaque-next/+=' });
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  const url = new URL(call.url);
  expect(url.pathname).toBe(`/v1/accounts/${draft.creatorAccountId}/editions`);
  expect([...url.searchParams]).toEqual([
    ['limit', '20'],
    ['cursor', 'opaque-current/+='],
  ]);
  expect(call.headers.get('authorization')).toBe('Bearer current-creator');
  expect(call.method).toBe('GET');
  expect(call.cache).toBe('no-store');
  expect(call.redirect).toBe('manual');
  const html = renderToStaticMarkup(
    createElement(CreatorEditionsView, {
      page: { kind: 'ready', editions: [], next: 'opaque-next/+=' },
      cursor: 'opaque-current/+=',
    }),
  );
  expect(html).toContain(m.creator_editions_sparse());
  expect(html).toContain(`cursor=${encodeURIComponent('opaque-next/+=')}`);
  expect(html).not.toContain(m.creator_editions_empty());
  expect(html).not.toContain('<li');
  expect(calls).toHaveLength(1);
});

test('only the native own-account session chooses the account, never a bearer or client owner selector', async () => {
  const calls: Parameters<CreatorEditionsApi['get']>[] = [];
  const caller: CreatorEditionsApi = {
    get: async (...args) => {
      calls.push(args);
      return { status: 200, data: { editions: [draft], next: null } };
    },
  };
  const sessionEnv = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'configured',
    SESSIONS: {
      idFromName: () => ({}),
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: draft.creatorAccountId,
          accessToken: 'native-session-token',
          csrfToken: 'csrf',
        }),
      }),
    },
  } as unknown as SessionEnv;
  const search = creatorEditionsSearch({ cursor: 'opaque', accountId: 'foreign', sellerActor: 'foreign' });
  expect(search).toEqual({ cursor: 'opaque' });
  const own = new Request('https://site.test/en/editions?accountId=foreign', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  expect((await loadSessionCreatorEditions(own, sessionEnv, caller, search)).kind).toBe('ready');
  expect(calls).toEqual([[draft.creatorAccountId, 'Bearer native-session-token', { cursor: 'opaque' }]]);
  const bearer = new Request('https://site.test/en/editions', { headers: { authorization: 'Bearer foreign' } });
  expect(await loadSessionCreatorEditions(bearer, sessionEnv, caller, {})).toEqual({ kind: 'sign-in' });
  expect(calls).toHaveLength(1);
  expect(isSignedInPath('/en/editions')).toBe(true);
  expect(isSignedInPath('/zh-Hant/editions/')).toBe(true);
  expect(isSignedInPath(`/en/editions/${published.editionId}`)).toBe(false);
});

test('absent native, current denial, stale continuation and malformed metadata never become empty or actionable', async () => {
  expect(await load(unavailableCreatorEditionsApi)).toEqual({ kind: 'unavailable' });
  expect(await load(createNativeCreatorEditionsApi())).toEqual({ kind: 'unavailable' });
  for (const [status, kind] of [
    [401, 'sign-in'],
    [403, 'denied'],
    [404, 'unavailable'],
    [409, 'stale'],
    [503, 'unavailable'],
  ] as const) {
    const page = await load(api({ editions: [published], next: null }, status));
    expect(page).toEqual({ kind });
    const html = renderToStaticMarkup(createElement(CreatorEditionsView, { page }));
    expect(html).not.toContain(published.editionId);
    expect(html).not.toContain(m.creator_editions_empty());
    expect(html).not.toContain('/creator/offers/new');
  }
  for (const editions of [
    [{ ...published, body: 'private body' }],
    [{ ...published, title: 'forged title' }],
    [{ ...published, state: 'unknown' }],
    [{ ...published, creatorAccountId: 'foreign' }],
    [{ ...published, sha256: 'bad digest' }],
    [published, published],
    Array(21).fill(published),
  ])
    expect(await load(api({ editions, next: null }))).toEqual({ kind: 'unavailable' });
  expect(await load(api({ editions: [], next: 'same' }), 'same')).toEqual({ kind: 'unavailable' });
  expect(
    await load({
      get: async () => {
        throw new Error('Native unavailable');
      },
    }),
  ).toEqual({ kind: 'unavailable' });
});

test('retry rechecks the same page and drops earlier actionable metadata when current access is refused', async () => {
  let status = 200;
  const cursors: (string | undefined)[] = [];
  const caller: CreatorEditionsApi = {
    get: async (_account, _credential, search) => {
      cursors.push(search.cursor);
      return { status, data: { editions: [published], next: null } };
    },
  };
  expect((await load(caller, 'same-page')).kind).toBe('ready');
  status = 403;
  const denied = await load(caller, 'same-page');
  expect(denied).toEqual({ kind: 'denied' });
  const html = renderToStaticMarkup(createElement(CreatorEditionsView, { page: denied, cursor: 'same-page' }));
  expect(html).toContain('cursor=same-page');
  expect(html).not.toContain(published.editionId);
  expect(cursors).toEqual(['same-page', 'same-page']);
});
