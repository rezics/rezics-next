import { describe, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { createFakeKernelFetch } from '../src/kernel/fake';
import fixtures from '../src/kernel/fixtures.json';
import { qualifiedRealm, qualifiedSubject } from '../src/kernel/fake/qualified-relations';
import { deLocalizeUrl, localizeUrl } from '../src/paraglide/runtime.js';
import { subjectHref } from '../src/subject/subject-href';
import type { SubjectLibrarySlotData } from '../src/library/subject-slot';
import type { useSession } from '../src/session/query';

// Keep the actual frame, shared Library renderer, query keys and reader responses; only substitute the Worker boundary.
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadViewPages, subjectFrame, SubjectFrame, SubjectViewPage } =
  await import('../src/features/pages/subject-frame');
const { SubjectLibraryLeaf, subjectLibraryLeafQuery } = await import('../src/features/pages/subject-library-leaf');
const queries = await import('../src/features/pages/subject-queries');
const { subjectLibraryQuery } = queries;
const { subjectPageMessages, viewTabLabels } = await import('../src/features/pages/route-support');
const { subjectTabs } = await import('../src/features/pages/views');

type Session = ReturnType<typeof useSession>;
const signedOut: Session = { state: 'signed-out', subject: null, csrfToken: null };
const viewer: Session = { state: 'signed-in', subject: 'reader-a', csrfToken: 'session-a' };
const sent: string[] = [];
const native = createFakeKernelFetch(fixtures as never);
const kernel = createKernelClient('https://kernel.invalid', {
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push(`${request.method} ${new URL(request.url).pathname}`);
    return native(request);
  }) as typeof fetch,
});
const loaded = await loadViewPages(kernel, qualifiedSubject.id, 'credits', 'en', undefined, { realm: qualifiedRealm });
if (loaded.kind !== 'page') throw new Error('Expected a successful current subject view');
const frame = subjectFrame(loaded.overview, 'en')!;
if (!frame) throw new Error('Expected the current subject frame');
const canonical = subjectHref({ id: frame.id, label: frame.title.text }, 'en').href;
const current = `${canonical}/credits?realm=${qualifiedRealm}&node=cast&cursor=cast-next`;
const personal: SubjectLibrarySlotData = {
  session: 'signed-in',
  csrfToken: viewer.csrfToken,
  entryAvailable: true,
  entry: { subjectId: frame.id, state: 'private-state', revision: 1 },
  entryStateLabel: 'Private reader state',
  publicCollections: null,
  publicCollectionsNext: null,
  collectionsLoaded: false,
  collections: null,
  labels: [],
};

function frameElement(session?: Session) {
  return createElement(SubjectFrame, {
    frame,
    locale: 'en',
    realm: qualifiedRealm,
    unlabelled: 'Unlabelled',
    tabs: subjectTabs(loaded.overview),
    tabLabels: viewTabLabels(),
    view: 'credits',
    ...(session ? { library: createElement(SubjectLibraryLeaf, { frame, locale: 'en', session }) } : {}),
  });
}

async function readerMarkup(session: Session, client = new QueryClient(), path = current) {
  client.setQueryData(['exposure', 'anonymous'], ['personal_library']);
  const root = createRootRoute({
    component: () =>
      createElement(SubjectViewPage, {
        page: loaded.page,
        subjectLabel: frame.title.text,
        locale: 'en',
        messages: subjectPageMessages(),
        view: 'credits',
        frame: frameElement(session),
        label: 'Credits',
        renderJsonLd: false,
      }),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [path] }),
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url).href,
      output: ({ url }) => localizeUrl(url, { locale: 'en' }).href,
    },
  });
  await router.load();
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
  );
  if (!html) throw new Error(JSON.stringify(router.state.matches.map(({ status, error }) => ({ status, error }))));
  return html;
}

describe('An ordinary non-overview subject view can use the same Library leaf for its current successful reader subject, preserving Realm and view on sign-in/return without a second Library renderer or private cache leak', () => {
  test('the current native frame supplies one shared leaf, compact navigation and the independent view heading', async () => {
    const client = new QueryClient();
    sent.length = 0;
    try {
      const html = await readerMarkup(signedOut, client);
      expect(html.match(/data-slot="subject-library"/g)).toHaveLength(1);
      expect(html.match(/data-library-sign-in/g)).toHaveLength(1);
      expect(html).toContain(`href="/auth/sign-in?return_to=${encodeURIComponent(current)}"`);
      expect(html).toContain('data-slot="subject-header"');
      expect(html).toContain('data-slot="view-tabs"');
      expect(html).toContain('>Credits</h1>');
      expect(html.indexOf('data-slot="subject-frame"')).toBeLessThan(html.indexOf('>Credits</h1>'));
      expect(html).not.toContain('private-state');
      expect(html).not.toContain('name="csrf_token"');
      expect(sent).toEqual([]);
      expect(client.getQueryCache().findAll({ queryKey: ['subject-library'] })).toHaveLength(1);
    } finally {
      client.clear();
    }
  });

  test('unrelated router contexts retain the existing canonical fallback for the actual current subject', async () => {
    const client = new QueryClient();
    try {
      const html = await readerMarkup(signedOut, client, '/en/search?realm=borrowed&return_to=https%3A%2F%2Fevil.test');
      expect(html).toContain(`href="/auth/sign-in?return_to=${encodeURIComponent(canonical)}"`);
      expect(html).not.toContain('return_to=https');
    } finally {
      client.clear();
    }
  });

  test('plain companion frames still render without query or router context and make no personal read', () => {
    const html = renderToStaticMarkup(frameElement());
    expect(html).toContain('data-slot="subject-header"');
    expect(html).toContain('data-slot="view-tabs"');
    expect(html).not.toContain('data-slot="subject-library"');
  });

  test('unknown, unavailable and SSR viewers reserve space without sign-in flash or cached personal hydration', async () => {
    expect(typeof window).toBe('undefined');
    const client = new QueryClient();
    client.setQueryData(subjectLibraryLeafQuery(frame, 'en', viewer).queryKey, personal);
    client.setQueryData(
      subjectLibraryQuery(frame.id, 'en', false, undefined, undefined, frame.type).queryKey,
      personal,
    );
    try {
      for (const session of [
        { state: 'unknown', csrfToken: null } as const,
        { state: 'unavailable', csrfToken: null } as const,
        viewer,
      ]) {
        const html = await readerMarkup(session, client);
        expect(html).toContain('min-h-9');
        expect(html).not.toContain('data-library-sign-in');
        expect(html).not.toContain('Private reader state');
        expect(html).not.toContain('private-state');
      }
      const html = await readerMarkup(signedOut, client);
      expect(html).toContain('data-library-sign-in');
      expect(html).not.toContain('private-state');
    } finally {
      client.clear();
    }
  });

  test('one current-frame query shares the existing invalidation prefix and isolates viewers, credentials and subjects', () => {
    const query = subjectLibraryLeafQuery(frame, 'en', viewer);
    const base = subjectLibraryQuery(frame.id, 'en', false, undefined, undefined, frame.type);
    expect(query.queryKey.slice(0, -1)).toEqual(base.queryKey);
    expect(query.select(personal)).toBe(personal);
    for (const session of [
      { ...viewer, subject: 'reader-b', csrfToken: 'session-b' },
      { ...viewer, subject: null },
      signedOut,
    ]) {
      const other = subjectLibraryLeafQuery(frame, 'en', session);
      expect(other.queryKey).not.toEqual(query.queryKey);
      expect(other.select(personal).session).toBe('unavailable');
    }
    for (const csrfToken of [null, 'new-session-a']) {
      const read = subjectLibraryLeafQuery(frame, 'en', { ...viewer, csrfToken });
      expect(read.enabled).toBe(true);
      expect(read.select(personal)).toBe(personal);
    }
    const otherSubject = { ...frame, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99' };
    expect(subjectLibraryLeafQuery(otherSubject, 'en', viewer).select(personal).entry).toBeNull();
    expect(query.select({ ...personal, session: 'unavailable' }).session).toBe('unavailable');
    expect(query.select({ ...personal, session: 'signed-out' }).session).toBe('unavailable');
    expect(query.select({ ...personal, entryAvailable: false, entry: null }).entryAvailable).toBe(false);
    const client = new QueryClient();
    try {
      client.setQueryData(query.queryKey, personal);
      expect(client.getQueryData(subjectLibraryLeafQuery(otherSubject, 'en', viewer).queryKey)).toBeUndefined();
      expect(
        client.getQueryData(subjectLibraryLeafQuery(frame, 'en', { ...viewer, csrfToken: 'new' }).queryKey),
      ).toBeUndefined();
    } finally {
      client.clear();
    }
  });

  test('concurrent reads deduplicate and a response from another session never enters the viewer cache', async () => {
    let reads = 0;
    // Substitute only the personal transport result to exercise a session change while a request is in flight.
    const source = spyOn(queries, 'subjectLibraryQuery').mockImplementation((...args) => ({
      ...subjectLibraryQuery(...args),
      queryFn: async () => {
        reads++;
        return personal;
      },
    }));
    const client = new QueryClient();
    try {
      const owner = subjectLibraryLeafQuery(frame, 'en', viewer);
      const result = await Promise.all([client.fetchQuery(owner), client.fetchQuery(owner)]);
      expect(result).toEqual([personal, personal]);
      expect(reads).toBe(1);
      const changed = subjectLibraryLeafQuery(frame, 'en', {
        state: 'signed-in',
        subject: 'reader-b',
        csrfToken: 'session-b',
      });
      expect((await client.fetchQuery(changed)).session).toBe('unavailable');
      expect(client.getQueryData(changed.queryKey)?.entry).toBeNull();
      expect(JSON.stringify(client.getQueryData(changed.queryKey))).not.toContain('private-state');
      expect(subjectLibraryLeafQuery(frame, 'en', signedOut).enabled).toBe(false);
      expect((await client.fetchQuery(subjectLibraryLeafQuery(frame, 'en', signedOut))).session).toBe('unavailable');
      expect(reads).toBe(2);
    } finally {
      source.mockRestore();
      client.clear();
    }
  });
});
