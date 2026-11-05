import { describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { deLocalizeUrl, locales, localizeUrl } from '../src/paraglide/runtime.js';
import { subjectSlotReturnTo } from '../src/library/subject-slot-return-context';
import type { SubjectLibrarySlotData } from '../src/library/subject-slot';
import { subjectHref } from '../src/subject/subject-href';
import recording from '../src/kernel/recorded/subject.json';
import realmRecording from '../src/kernel/recorded/realm.json';

// Only the unused Worker/server-function boundary is substituted. No session or native sign-in is simulated.
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectLibrarySlot } = await import('../src/library/subject-slot-view');

const subject = { id: recording.subject.id, label: recording.subject.labels.en, type: recording.subject.type };
const realm = realmRecording.realm.realmId;
const canonical = subjectHref(subject, 'en').href;
const signedOut: SubjectLibrarySlotData = {
  session: 'signed-out',
  csrfToken: null,
  entryAvailable: false,
  entry: null,
  publicCollections: null,
  publicCollectionsNext: null,
  collectionsLoaded: false,
  collections: null,
  labels: null,
};

async function slotMarkup(path: string, data = signedOut, admitted = ['personal_library']) {
  const client = new QueryClient();
  client.setQueryData(['exposure', 'anonymous'], admitted);
  const root = createRootRoute({ component: () => createElement(SubjectLibrarySlot, { subject, locale: 'en', data }) });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [path] }),
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url).href,
      output: ({ url }) => localizeUrl(url, { locale: 'en' }).href,
    },
  });
  await router.load();
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  } finally {
    client.clear();
  }
}

describe('Library sign-in from a Realm reader preserves the validated local reader Realm and view without creating authority or an open redirect', () => {
  test('the actual SSR Library link uses publicHref, including the current work/edition identity and view', async () => {
    expect(typeof window).toBe('undefined');
    const current = `${canonical}?realm=${realm}&slot=collections`;
    const html = await slotMarkup(current);
    expect(html).toContain(`href="/auth/sign-in?return_to=${encodeURIComponent(current)}"`);
    expect(html).not.toContain('name="csrf_token"');
    expect(html).not.toContain('name="intent"');

    // The same leaf consumes a current view address without reconstructing it from the subject label.
    const view = `${canonical}/editions?realm=${realm}&node=editions&cursor=opaque%2B%2F%3D%20next`;
    expect(await slotMarkup(view)).toContain(`href="/auth/sign-in?return_to=${encodeURIComponent(view)}"`);
  });

  test('only the current subject reader is eligible; absent, unrelated and invalid locations use the canonical subject', () => {
    for (const current of [
      undefined,
      '',
      '/',
      '/en/search?q=book',
      '/en/settings',
      '/en/subjects/other/book',
      `${canonical}/edit`,
      `${canonical}/overview`,
    ]) {
      expect(subjectSlotReturnTo(current, subject, 'en')).toBe(canonical);
    }
    expect(subjectSlotReturnTo(canonical, subject, 'en')).toBe(canonical);
    const selectedTitle = `/en/subjects/${subject.id}/current-realm-title?realm=${realm}`;
    expect(subjectSlotReturnTo(selectedTitle, subject, 'en')).toBe(selectedTitle);
    const edition = { ...subject, id: '00000000-0000-8000-8000-000000000010' };
    const editionView = `/en/subjects/${edition.id}/selected-edition/contents?realm=${realm}`;
    expect(subjectSlotReturnTo(editionView, edition, 'en')).toBe(editionView);
  });

  test('rejects external, protocol-relative, backslash, encoded and malformed path tricks', () => {
    for (const current of [
      `https://evil.test${canonical}`,
      `https://rezics.invalid${canonical}`,
      `//evil.test${canonical}`,
      `/\\evil.test${canonical}`,
      `\\\\evil.test${canonical}`,
      `javascript:alert(1)`,
      `/%2f%2fevil.test${canonical}`,
      `/%252f%252fevil.test${canonical}`,
      `/%5cevil.test${canonical}`,
      `${canonical}%2fextra`,
      `${canonical}%255cevil`,
      `${canonical}%0d%0aLocation:evil`,
      `${canonical}%`,
      `${canonical}\n`,
    ]) {
      expect(subjectSlotReturnTo(current, subject, 'en')).toBe(canonical);
    }
  });

  test('preserves current reader selectors and their bytes while excluding credentials and arbitrary redirect input', () => {
    const view = `${canonical}/editions`;
    const query = `realm=${realm}&node=editions&cursor=opaque%2B%2F%3D%20next`;
    const privateQuery = 'code=private-code&csrf_token=private-csrf&access_token=private-token&undoKey=private-key';
    const redirects = 'return_to=https%3A%2F%2Fevil.test&next=%2F%2Fevil.test&redirect_uri=%5C%5Cevil.test';
    expect(
      subjectSlotReturnTo(`${view}?${privateQuery}&${query}&${redirects}#access_token=secret`, subject, 'en'),
    ).toBe(`${view}?${query}`);
    expect(subjectSlotReturnTo(`${canonical}?slot=collections&cursor=unowned&node=unowned`, subject, 'en')).toBe(
      `${canonical}?slot=collections`,
    );
    for (const query of [`realm=https%3A%2F%2Fevil.test`, `realm=${realm}&realm=${realm}`, 'node=../bad', 'cursor=']) {
      expect(subjectSlotReturnTo(`${view}?${query}`, subject, 'en')).toBe(canonical);
    }
  });

  test('uses the existing locale helpers for all eight locales and never duplicates a public locale prefix', () => {
    for (const locale of locales) {
      const localized = subjectHref({ ...subject, label: recording.subject.labels[locale] }, locale).href;
      const view = `${localized}/editions?realm=${realm}&node=editions`;
      const encoded = new URL(view, 'https://rezics.invalid');
      expect(subjectSlotReturnTo(view, subject, locale)).toBe(encoded.pathname + encoded.search);
      expect(subjectSlotReturnTo(deLocalizeUrl(encoded).pathname + encoded.search, subject, locale)).toBe(
        encoded.pathname + encoded.search,
      );
      expect(subjectSlotReturnTo(undefined, subject, locale)).toBe(subjectHref(subject, locale).href);
    }
  });

  test('a Realm or authority-looking query cannot create a session, an operation grant or a Library mutation form', async () => {
    const path = `${canonical}?realm=${realm}&context=private-context&authorization=Bearer+secret&grants=all`;
    expect(subjectSlotReturnTo(path, subject, 'en')).toBe(`${canonical}?realm=${realm}`);
    expect(await slotMarkup(path, { ...signedOut, session: 'unavailable' })).not.toContain('data-library-sign-in');
    expect(await slotMarkup(path, signedOut, [])).not.toContain('data-library-sign-in');
    const html = await slotMarkup(path);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('private-context');
    expect(html).not.toContain('Bearer');
    expect(signedOut.session).toBe('signed-out');
  });
});
