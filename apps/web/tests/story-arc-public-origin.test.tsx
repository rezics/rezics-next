import { expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { StoryArcProfileEntry } from '../src/features/catalogue/story-arc-profile-entry';
import {
  parseStoryArcProfileSearch,
  storyArcCanonicalSlugTarget,
  storyArcGlobalChoiceHref,
  storyArcPublicOrigin,
} from '../src/features/catalogue/story-arc-public-visit';
import { subjectHref } from '../src/subject/subject-href';

const subjectId = '5d0a0000-0000-4000-8000-000000000001';
const otherSubjectId = '5d0a0000-0000-4000-8000-000000000002';
const realmId = '5d0a0000-0000-4000-8000-000000000003';

test('the actual Subject entry carries current Context, admitted Realm, Definition and one immediate return', () => {
  const subject = subjectHref({ id: subjectId, label: 'A named arc' }, 'en');
  const via = storyArcPublicOrigin({
    currentHref: `${subject.href}?realm=${realmId}`,
    id: subjectId,
    locale: 'en',
    realm: realmId,
  })!;
  const html = renderToStaticMarkup(
    createElement(StoryArcProfileEntry, {
      id: subjectId,
      label: 'A named arc',
      locale: 'en',
      context: realmId,
      realm: realmId,
      definition: 'sha256:current-release',
      via,
    }),
  );
  const href = html.match(/href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  expect(href).toBeDefined();
  const address = new URL(href!, 'https://site.test');
  const parsed = parseStoryArcProfileSearch(address.search, subjectId, 'en');
  expect(parsed).toMatchObject({
    context: realmId,
    realm: realmId,
    definition: 'sha256:current-release',
    via,
  });
  expect(new URL(parsed!.via!, 'https://site.test').pathname).toBe(new URL(subject.href, 'https://site.test').pathname);
});

test('outer route input rejects malformed, duplicate, mismatched and over-budget origins; Global keeps only return', () => {
  const origin = subjectHref({ id: subjectId, label: 'A named arc' }, 'en').href;
  const via = `${origin}#connections`;
  const encoded = encodeURIComponent(via);
  expect(parseStoryArcProfileSearch(`via=${encoded}%`, subjectId, 'en')).toBeUndefined();
  expect(parseStoryArcProfileSearch(`via=${encoded}&via=${encoded}`, subjectId, 'en')).toBeUndefined();
  expect(parseStoryArcProfileSearch(`via=${encodeURIComponent(`/${'en'}/subjects/${otherSubjectId}/arc#connections`)}`, subjectId, 'en')).toBeUndefined();
  expect(parseStoryArcProfileSearch(`via=${encodeURIComponent(`/ja/subjects/${subjectId}/arc#connections`)}`, subjectId, 'en')).toBeUndefined();
  expect(parseStoryArcProfileSearch(`via=${encodeURIComponent(`${origin}/relations#connections`)}`, subjectId, 'en')).toBeUndefined();
  expect(parseStoryArcProfileSearch(`via=${'😀'.repeat(600)}`, subjectId, 'en')).toBeUndefined();

  const realmVia = storyArcPublicOrigin({ currentHref: `${origin}?realm=${realmId}`, id: subjectId, locale: 'en', realm: realmId })!;
  const choice = storyArcGlobalChoiceHref({ id: subjectId, slug: 'a-named-arc', locale: 'en', via: realmVia });
  const choiceUrl = new URL(choice, 'https://site.test');
  expect([...choiceUrl.searchParams.keys()]).toEqual(['via']);
  expect(parseStoryArcProfileSearch(choiceUrl.search, subjectId, 'en')).toMatchObject({ via: realmVia });
  expect(
    parseStoryArcProfileSearch(`context=${PAGE_GLOBAL_CONTEXT}&via=${encodeURIComponent(realmVia)}`, subjectId, 'en'),
  ).toBeUndefined();
});

test('canonical slug changes redirect only for the same identity', () => {
  expect(
    storyArcCanonicalSlugTarget({
      id: subjectId,
      slug: 'old-title',
      currentId: subjectId,
      label: 'A named arc',
      locale: 'en',
    }),
  ).toBe(subjectHref({ id: subjectId, label: 'A named arc' }, 'en').href);
  expect(
    storyArcCanonicalSlugTarget({
      id: subjectId,
      slug: 'old-title',
      currentId: otherSubjectId,
      label: 'A named arc',
      locale: 'en',
    }),
  ).toBeUndefined();
});

test('session refusal mounts no Global profile read and its Global choice retains only the validated return', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/story-arc/story-arc' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  const loads: unknown[] = [];
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('../src/features/catalogue/story-arc-profile-actions', () => ({
    loadStoryArcProfile: async ({ data }: { data: unknown }) => {
      loads.push(data);
      return { ok: false, reason: 'unavailable' };
    },
  }));
  const [{ createRoot }, { QueryClient, QueryClientProvider }, { sessionQueryKey }, { StoryArcProfileSession }] =
    await Promise.all([
      import('react-dom/client'),
      import('@tanstack/react-query'),
      import('../src/session/browser-state'),
      import('../src/features/catalogue/story-arc-profile-session'),
    ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQueryKey, { state: 'signed-in', csrfToken: 'session-token', subject: 'account-id' });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const subject = subjectHref({ id: subjectId, label: 'A named arc' }, 'en');
  const via = storyArcPublicOrigin({ currentHref: subject.href, id: subjectId, locale: 'en' })!;
  const choice = storyArcGlobalChoiceHref({ id: subjectId, slug: subject.params.slug, locale: 'en', via });
  const render = (props: Record<string, unknown>) =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(StoryArcProfileSession, { id: subjectId, locale: 'en', via, globalChoiceHref: choice, ...props } as never),
      ),
    );
  try {
    await act(async () => render({ context: otherSubjectId, definition: 'sha256:source-release', address: 'origin-a' }));
    expect(host.textContent).toContain('StoryArc correction supports Global only');
    expect(client.getQueryCache().findAll({ queryKey: ['story-arc-profile'] })).toHaveLength(0);
    const globalLink = [...host.querySelectorAll('a')].find((link) => link.textContent?.includes('Global correction'))!;
    expect([...new URL(globalLink.href).searchParams.keys()]).toEqual(['via']);

    await act(async () => {
      render({ via, address: JSON.stringify([undefined, via]) });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(loads).toEqual([{ id: subjectId, work: undefined }]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
