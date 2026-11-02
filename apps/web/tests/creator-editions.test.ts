import { expect, mock, test } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
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
const { CreatorEditionsView, creatorEditionsHref } = await import('../src/content-editions/creator-editions-view');
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
  const calls: { request: Request; cache: RequestCache | undefined; redirect: RequestRedirect | undefined }[] = [];
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ request: new Request(input, init), cache: init?.cache, redirect: init?.redirect });
      return Response.json({ editions: [], next: 'opaque-next/+=' });
    },
    { preconnect() {} },
  );
  const native = createNativeCreatorEditionsApi('https://kernel.test', fetcher);
  expect(await load(native, 'opaque-current/+=')).toEqual({ kind: 'ready', editions: [], next: 'opaque-next/+=' });
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  const url = new URL(call.request.url);
  expect(url.pathname).toBe(`/v1/accounts/${draft.creatorAccountId}/editions`);
  expect([...url.searchParams]).toEqual([
    ['limit', '20'],
    ['cursor', 'opaque-current/+='],
  ]);
  expect(call.request.headers.get('authorization')).toBe('Bearer current-creator');
  expect(call.request.method).toBe('GET');
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

test('route transport errors retain the current continuation for retry alongside first-page recovery', async () => {
  const { Route } = await import('../src/routes/editions/index');
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: '/editions/',
    validateSearch: creatorEditionsSearch,
    loader: () => {
      throw new Error('Transport failed');
    },
    errorComponent: Route.options.errorComponent,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: ['/editions/?cursor=opaque%2F%2B%3D'],
    }),
  });
  await router.load();
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  expect(html).toContain(`href="${creatorEditionsHref('opaque/+=')}"`);
  expect(html).toContain(`href="${creatorEditionsHref()}"`);
  expect(html).toContain(m.creator_editions_restart());
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

test('unavailable continuations offer retry and first-page recovery while denials, stale results and malformed metadata remain distinct', async () => {
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
    const recovery = renderToStaticMarkup(createElement(CreatorEditionsView, { page, cursor: 'opaque/+=' }));
    if (kind === 'unavailable')
      for (const href of [creatorEditionsHref('opaque/+='), creatorEditionsHref()])
        expect(recovery).toContain(`href="${href}"`);
    expect(html.includes(m.creator_editions_restart())).toBe(kind === 'stale');
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

test('A creator recognizes a bounded edition list item by authorized document or subject title revision date and state selects its recognizable target and confirms that same exact edition revision before publication while hidden metadata and uncertain original command custody remain protected', async () => {
  const { publicationFixture, subjectId, editionId, creatorId, postId, revisionId } =
    await import('../src/stories/patterns/edition-publication/edition-publication-fixtures');
  const { EditionPublicationController } = await import('../src/content-editions/edition-create');
  const { EditionPublication } = await import('../src/content-editions/edition-create-view');
  const { editionRevisionDate } = await import('../src/content-editions/edition-identity');
  const fixture = await publicationFixture('selection');
  const source = fixture.controller.snapshot().source!;
  expect(source.recognition?.revisionId).toBe(revisionId);
  expect(source.recognition?.subjects[0]?.label?.value).toBe('夜の航路');
  const selection = renderToStaticMarkup(createElement(EditionPublication, { controller: fixture.controller }));
  expect(selection).toContain('lang="ja"');
  expect(selection).toMatch(new RegExp(`<option[^>]*value="${subjectId}"[^>]*>夜の航路</option>`));
  expect(selection).not.toContain(`>${subjectId}</option>`);
  fixture.controller.chooseSubject(subjectId);
  await fixture.controller.create();

  const listApi = createNativeCreatorEditionsApi('https://kernel.example', fixture.fetcher);
  const page = await loadCreatorEditions(listApi, creatorId, 'Bearer story-creator', {});
  expect(page.kind).toBe('ready');
  if (page.kind !== 'ready') throw new Error('Expected one authorized edition page');
  expect(page.editions).toHaveLength(1);
  const selected = page.editions[0]!;
  const list = renderToStaticMarkup(createElement(CreatorEditionsView, { page }));
  expect(list).toContain('夜の航路</h2>');
  expect(list).toContain('editionId=' + editionId);
  expect(list).toContain(editionRevisionDate(selected.identity?.revisionCreatedAt));
  expect(list).toContain(m.creator_editions_draft());
  expect(list).not.toContain(`${editionId}</h2>`);

  const controller = new EditionPublicationController(fixture.api);
  await controller.resume(selected.editionId);
  expect(controller.snapshot().edition?.revisionId).toBe(revisionId);
  expect(controller.snapshot().edition?.sha256).toBe(source.sha256);
  const review = () => renderToStaticMarkup(createElement(EditionPublication, { controller }));
  expect(review()).toContain(
    m.edition_publication_confirm({
      revision: editionRevisionDate(selected.identity?.revisionCreatedAt),
      licence: selected.licence,
      subject: '夜の航路',
    }),
  );

  fixture.withholdIdentity();
  await controller.refresh();
  controller.acceptReview();
  expect(review()).toContain(m.edition_identity_withheld());
  expect(review()).not.toContain('夜の航路');
  expect(review()).toMatch(/type="checkbox"[^>]*disabled=""/);
  expect(review()).toContain(m.edition_publication_refresh());
  fixture.restoreIdentity();
  await controller.refresh();
  controller.acceptReview();

  fixture.staleVersion();
  await controller.publish();
  expect(controller.snapshot().failure?.kind).toBe('conflict');
  expect(controller.snapshot().edition?.editionRevision).toBe('1');
  await controller.refresh();
  expect(controller.snapshot().review?.edition?.editionRevision).toBe('2');
  expect(controller.snapshot().edition?.editionRevision).toBe('1');
  controller.acceptReview();
  expect(controller.snapshot().edition?.revisionId).toBe(revisionId);
  expect(controller.snapshot().edition?.editionRevision).toBe('2');
  expect(review()).toContain('夜の航路');
  expect(review()).not.toContain('checked=""');

  fixture.failPublicationRead();
  await controller.publish();
  const receipt = controller.snapshot().failure?.receipt;
  const originalIntent = controller.snapshot().intent;
  expect(receipt).toEqual({ editionId, editionRevision: '3' });
  expect(originalIntent?.kind).toBe('publish');
  expect(controller.snapshot().uncertain).toBe(true);
  expect(review()).toContain(m.edition_identity_recorded());
  expect(review()).not.toContain(m.edition_publication_retry());
  const writes = () => fixture.calls.filter((call) => call.method === 'POST' && call.path.endsWith(':publish'));
  const sent = writes().length;
  await controller.refresh();
  expect(controller.snapshot().failure?.receipt).toEqual(receipt);
  expect(controller.snapshot().intent).toBe(originalIntent);
  fixture.restoreRead();
  await controller.refresh();
  expect(controller.snapshot().edition?.state).toBe('published');
  expect(controller.snapshot().edition?.revisionId).toBe(revisionId);
  expect(controller.snapshot().intent).toBeNull();
  expect(writes()).toHaveLength(sent);
  expect(review()).toContain('夜の航路');

  // A genuinely lost response still locks the original sealed input, unlike a recorded success.
  const lost = await publicationFixture('uncertain-publish');
  const locked = lost.controller.snapshot().intent!;
  expect(lost.controller.snapshot().uncertain).toBe(true);
  lost.withholdIdentity();
  await lost.controller.refresh();
  lost.controller.acceptReview();
  expect(lost.controller.snapshot().intent).toBe(locked);
  expect(lost.controller.snapshot().uncertain).toBe(true);
  lost.restoreIdentity();
  await lost.controller.refresh();
  await lost.controller.retry();
  const replays = lost.calls.filter((call) => call.path.endsWith(':publish'));
  expect(replays).toHaveLength(2);
  expect(replays[0]!.headers.get('idempotency-key')).toBe(replays[1]!.headers.get('idempotency-key'));
  expect(replays[0]!.headers.get('if-match')).toBe(replays[1]!.headers.get('if-match'));
  expect(replays[0]!.body).toBe(replays[1]!.body);
  expect(lost.controller.snapshot().edition?.state).toBe('published');
  expect(lost.controller.snapshot().edition?.revisionId).toBe(revisionId);
  // Candidate labels arrive in one native batch, never one subject request per option/card.
  expect(fixture.calls.filter((call) => call.path === `/v1/posts/${postId}/revisions/${revisionId}`)).toHaveLength(4);
});
