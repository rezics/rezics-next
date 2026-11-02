import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import { presentationEditorDictionary } from '../src/features/pages/curate-view-editor-messages';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

const ja = { locale: 'ja' as const };
const empty: CompositionDocument = { root: { props: {} }, content: [] };
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { views: { overview: empty, details: empty } },
  bases: [],
  types: [],
  routes: [],
};
const initial = {
  ok: true as const,
  reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
  profile,
  head: 7,
  digest: profileDigest(profile),
};

test('dictionary follows an explicit locale, keeps Puck tokens, and stays ambient when locale is omitted', () => {
  const previous = getLocale();
  setLocale('en', { reload: false });
  try {
    const dictionary = presentationEditorDictionary('ja');
    expect(dictionary['header-undo']).toBe(m.curation_puck_undo({}, ja));
    expect(dictionary['header-undo']).not.toBe(m.curation_puck_undo());
    expect(dictionary['drawer-category-collapse']).toBe(m.curation_puck_collapse_title({ title: '{title}' }, ja));
    expect(dictionary['drawer-category-collapse']).toContain('{title}');
    expect(dictionary['canvas-noconfig']).toContain('{type}');
    expect(dictionary['field-arrayitem-summary']).toContain('{index}');
    expect(dictionary['field-external-result-plural']).toContain('{count}');
    expect(dictionary['viewport-zoom-auto']).toContain('{zoom}');
    expect(dictionary['viewport-switch']).toContain('{label}');
    expect(dictionary['drawer-category-collapse']).not.toBe(m.curation_puck_collapse_title({ title: '{title}' }));
    expect(presentationEditorDictionary()['header-undo']).toBe(m.curation_puck_undo());
    expect(presentationEditorDictionary('not-a-locale')['header-undo']).toBe(m.curation_puck_undo());
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('view labels and editor controls follow an explicit locale while ambient English differs', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { PresentationViewEditor, presentationViewNames } = await import('../src/features/pages/curate-view-editor');
  const previous = getLocale();
  setLocale('en', { reload: false });
  try {
    const views = presentationViewNames('ja');
    expect(views.overview).toBe(m.subject_overview({}, ja));
    expect(views.overview).not.toBe(m.subject_overview());
    expect(presentationViewNames().overview).toBe(m.subject_overview());

    const html = renderToStaticMarkup(
      createElement(PresentationViewEditor, {
        initial,
        locale: 'ja',
        transport: { read: async () => initial, publish: async () => ({ ok: false, reason: 'unavailable' }) },
      }),
    );
    expect(html).toContain(m.curation_heading({}, ja));
    expect(html).toContain(m.curation_publish({}, ja));
    expect(html).toContain(m.curation_templates({}, ja));
    expect(html).toContain(m.curation_view({}, ja));
    expect(html).toContain(m.subject_overview({}, ja));
    expect(html).toContain(m.subject_details({}, ja));
    expect(html).not.toContain(m.curation_heading());
    expect(html).not.toContain(m.curation_publish());
    expect(html).not.toContain(m.subject_overview());
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('both departure warnings follow the editor locale while ambient English differs', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/curate/presentation', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { CurationNavigationGuard } = await import('../src/features/pages/curation-navigation-guard');
  const runtime = await import('../src/paraglide/runtime.js');
  const originalLocale = runtime.getLocale();
  runtime.setLocale('en', { reload: false });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const fallbackFocus = createRef<HTMLElement>();
  const show = (retainedPublication: boolean) => {
    const rootRoute = createRootRoute({ component: Outlet });
    const editorRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/curate/presentation',
      component: () =>
        createElement(
          'div',
          null,
          createElement(Link, { to: '/search' }, 'Search destination'),
          createElement(CurationNavigationGuard, {
            dirty: !retainedPublication,
            retainedPublication,
            fallbackFocus,
            locale: 'ja',
          }),
        ),
    });
    const destinationRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/search',
      component: () => createElement('h1', null, 'Actual search destination'),
    });
    return createRouter({
      routeTree: rootRoute.addChildren([editorRoute, destinationRoute]),
      history: createMemoryHistory({ initialEntries: ['/search', '/curate/presentation'] }),
    });
  };
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 150 && !ready(); count++)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(ready()).toBe(true);
  };
  const leave = async (retainedPublication: boolean, warning: string, ambient: string) => {
    const router = show(retainedPublication);
    await router.load();
    await act(async () => root.render(createElement(RouterProvider, { router })));
    await settle(() => !!host.querySelector('a'));
    await act(async () => {
      const link = host.querySelector('a') as HTMLElement;
      link.focus();
      link.click();
    });
    await settle(() => !!window.document.querySelector('[role="alertdialog"]'));
    const dialog = window.document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(warning);
    expect(dialog.textContent).not.toContain(ambient);
  };
  try {
    await leave(false, m.curation_leave_warning({}, ja), m.curation_leave_warning());
    await leave(true, m.curation_leave_recovery({}, ja), m.curation_leave_recovery());
  } finally {
    await act(async () => root.unmount());
    host.remove();
    runtime.setLocale(originalLocale, { reload: false });
    window.happyDOM.abort();
    for (const [key, value] of previous)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  }
});
