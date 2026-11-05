import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
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

test('editor controls, view labels and both departure warnings follow an explicit locale while ambient English differs', async () => {
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
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: window.Element,
    Node: window.Node,
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
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { PresentationViewEditor, presentationViewNames } = await import('../src/features/pages/curate-view-editor');
  const runtime = await import('../src/paraglide/runtime.js');
  const originalLocale = runtime.getLocale();
  runtime.setLocale('en', { reload: false });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const page = (id: string): CompositionDocument => ({
    root: { props: {} },
    content: [{ type: 'Heading', props: { id, level: 2, text: { en: 'Reading notes', ja: '読書ノート' } } }],
  });
  const authored: PresentationProfile = {
    format: PROFILE_FORMAT,
    generic: { views: { overview: page('overview'), details: page('generic-details') } },
    bases: [],
    types: [{ type: 'schema:Book', views: { overview: page('book'), details: page('details') } }],
    routes: [],
  };
  const read = {
    ok: true as const,
    reader: initial.reader,
    profile: authored,
    head: 7,
    digest: profileDigest(authored),
  };
  const initialLocation = '/curate/presentation';
  const rootRoute = createRootRoute({ component: Outlet });
  const editorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: initialLocation,
    component: () =>
      createElement(
        'div',
        null,
        createElement(Link, { to: '/search' }, 'Search destination'),
        createElement(PresentationViewEditor, {
          initial: read,
          locale: 'ja',
          transport: {
            read: async () => read,
            publish: async () => ({ ok: false, reason: 'unavailable', outcome: 'unknown' }),
          },
        }),
      ),
  });
  const destinationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/search',
    component: () => createElement('h1', null, 'Actual search destination'),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([editorRoute, destinationRoute]),
    history: createMemoryHistory({ initialEntries: ['/search', initialLocation] }),
  });
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 150 && !ready(); count++)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(ready(), router.state.location.pathname).toBe(true);
  };
  const button = (label: string) =>
    [...(window.document.querySelector('[role="alertdialog"]') ?? host).querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === label,
    )!;
  const textField = (name: string) => [...host.querySelectorAll('textarea')].find((field) => field.name === name);
  const leave = async (warning: string, ambient: string) => {
    await act(async () => {
      (host.querySelector('a') as HTMLElement).focus();
      (host.querySelector('a') as HTMLElement).click();
    });
    await settle(() => !!window.document.querySelector('[role="alertdialog"]'));
    expect(router.state.location.pathname).toBe(initialLocation);
    const dialog = window.document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(warning);
    expect(dialog.textContent).not.toContain(ambient);
    return dialog;
  };
  try {
    await router.load();
    await act(async () => root.render(createElement(RouterProvider, { router })));
    expect(presentationViewNames('ja').overview).toBe(m.subject_overview({}, ja));
    expect(presentationViewNames('ja').overview).not.toBe(m.subject_overview());
    expect(presentationViewNames().overview).toBe(m.subject_overview());
    expect(host.textContent).toContain(m.curation_heading({}, ja));
    expect(host.textContent).toContain(m.curation_publish({}, ja));
    expect(host.textContent).toContain(m.curation_templates({}, ja));
    expect(host.textContent).toContain(m.curation_view({}, ja));
    expect(host.textContent).toContain(m.subject_overview({}, ja));
    expect(host.textContent).not.toContain(m.curation_heading());
    expect(host.textContent).not.toContain(m.curation_publish());
    expect(host.textContent).not.toContain(m.subject_overview());
    await act(async () => button(`generic: ${m.curation_generic({}, ja)}`).click());
    await settle(() => !!host.querySelector('[data-puck-layer-tree-id="overview"]'));
    await act(async () => {
      const row = host.querySelector('[data-puck-layer-tree-id="overview"]')!;
      [...row.querySelectorAll('button')].find((control) => control.textContent === 'Heading')!.click();
    });
    await settle(() => !!textField('text.en'));
    await act(async () => {
      const field = textField('text.en')!;
      field.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Draft');
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
      field.blur();
    });
    await settle(() => host.textContent?.includes(m.curation_unsaved({}, ja)) === true);
    const draftDialog = await leave(m.curation_leave_warning({}, ja), m.curation_leave_warning());
    await act(async () => button(m.curation_stay({}, ja)).click());
    await settle(() => !window.document.querySelector('[role="alertdialog"]'));
    await act(async () => button(m.curation_publish({}, ja)).click());
    await settle(() => host.textContent?.includes(m.curation_unknown()) === true);
    await leave(m.curation_leave_recovery({}, ja), m.curation_leave_recovery());
  } finally {
    await act(async () => root.unmount());
    host.remove();
    runtime.setLocale(originalLocale, { reload: false });
    window.happyDOM.abort();
    for (const [key, value] of previous)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  }
}, 20_000);
