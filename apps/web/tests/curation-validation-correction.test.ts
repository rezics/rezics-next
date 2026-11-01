import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import type { PublishInput } from '../src/features/pages/curate';

test('default presentation editor takes a native invalid publication to its actual template view and editable field without replaying invalid intent', async () => {
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
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { PresentationViewEditor } = await import('../src/features/pages/curate-view-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const document = (id: string): CompositionDocument => ({
    root: { props: {} },
    content: [{ type: 'Heading', props: { id, level: 2, text: { en: 'Reading notes', ja: '読書ノート' } } }],
  });
  const profile: PresentationProfile = {
    format: PROFILE_FORMAT,
    generic: { views: { overview: document('overview'), details: document('generic-details') } },
    bases: [],
    types: [{ type: 'schema:Book', views: { overview: document('book'), details: document('details') } }],
    routes: [],
  };
  const initial = {
    ok: true as const,
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    profile,
    head: 7,
    digest: profileDigest(profile),
  };
  const attempts: PublishInput[] = [];
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const lookupButton = (label: string) =>
    [...host.querySelectorAll('button')].find(
      (item) =>
        item.textContent?.trim() === label ||
        item.getAttribute('aria-label') === label ||
        item.getAttribute('title') === label,
    );
  const button = (label: string) => {
    const match = lookupButton(label);
    expect(match).toBeDefined();
    return match!;
  };
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 150 && !ready(); count++)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(
      ready(),
      [...host.querySelectorAll('button')]
        .map((item) => [item.textContent, item.getAttribute('aria-label'), item.getAttribute('title')])
        .toString(),
    ).toBe(true);
  };
  const click = async (label: string) => {
    await act(async () => {
      button(label).click();
    });
  };
  const select = async (id: string, value: string) => {
    await act(async () => {
      const control = host.querySelector(`#${id}`)! as InstanceType<typeof window.HTMLSelectElement>;
      control.value = value;
      control.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const textField = (name: string) => [...host.querySelectorAll('textarea')].find((field) => field.name === name);
  const edit = async (name: string, value: string) => {
    await act(async () => {
      const field = textField(name)!;
      field.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
      field.blur();
    });
  };
  const heading = async (id: string) => {
    await settle(() => !!host.querySelector(`[data-puck-layer-tree-id="${id}"]`));
    await act(async () => {
      const row = host.querySelector(`[data-puck-layer-tree-id="${id}"]`)!;
      [...row.querySelectorAll('button')].find((control) => control.textContent === 'Heading')!.click();
    });
    await settle(() => !!textField('text.en'));
  };
  try {
    const route = createRootRoute({
      component: () =>
        createElement(PresentationViewEditor, {
          initial,
          locale: 'en',
          transport: {
            read: async () => initial,
            publish: async (input) => {
              attempts.push(structuredClone(input));
              return attempts.length === 1
                ? {
                    ok: false,
                    reason: 'invalid',
                    errors: [{ pointer: '/types/0/views/details/content/0/props/text/en', code: 'invalid' }],
                  }
                : { ok: true, digest: profileDigest(input.profile), head: input.expectedHead + 1 };
            },
          },
        }),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ['/en/curate/presentation'] }),
    });
    await router.load();
    await act(async () => {
      root.render(createElement(RouterProvider, { router }));
    });
    expect((host.querySelector('#curation-view') as InstanceType<typeof window.HTMLSelectElement>).value).toBe(
      'overview',
    );
    expect((host.querySelector('#curation-template') as InstanceType<typeof window.HTMLSelectElement>).value).toBe(
      JSON.stringify({ scope: 'generic', key: null }),
    );
    await click(m.curation_publish());
    expect(attempts).toHaveLength(1);
    expect(host.textContent).toContain(m.curation_invalid_retained());
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === m.curation_retry_original())).toBe(
      false,
    );

    // Later edits belong to the current editor, even though the error describes the retained intent.
    await select('curation-view', 'overview');
    await heading('overview');
    await edit('text.en', 'Later overview edit');
    await edit('text.fr', 'Brouillon');
    await edit('text.fr', '');
    await select('curation-template', JSON.stringify({ scope: 'type', key: 'schema:Book' }));
    await select('curation-view', 'details');
    await heading('details');
    await edit('text.ja', '後からの編集');
    await edit('text.fr', 'Détails');
    await edit('text.fr', '');
    await select('curation-view', 'overview');
    await select('curation-template', JSON.stringify({ scope: 'generic', key: null }));

    await click(m.curation_correct());
    await settle(() => window.document.activeElement === textField('text.en') && !!textField('text.en'));
    expect((host.querySelector('#curation-template') as InstanceType<typeof window.HTMLSelectElement>).value).toBe(
      JSON.stringify({ scope: 'type', key: 'schema:Book' }),
    );
    expect((host.querySelector('#curation-view') as InstanceType<typeof window.HTMLSelectElement>).value).toBe(
      'details',
    );
    expect(textField('text.ja')!.value).toBe('後からの編集');
    expect(textField('text.fr')!.value).toBe('');
    expect(host.textContent).toContain(m.curation_correction_later());
    expect(attempts).toHaveLength(1);
    await edit('text.en', 'Corrected heading');
    await click(m.curation_publish());
    await settle(() => attempts.length === 2 && !!host.textContent?.includes(m.curation_published({ head: 8 })));
    expect(attempts[1]!.keys.publish).not.toBe(attempts[0]!.keys.publish);
    expect(attempts[1]!.keys.activate).not.toBe(attempts[0]!.keys.activate);
    expect(attempts[1]!.expectedHead).toBe(7);
    expect(attempts[1]!.profile).not.toEqual(attempts[0]!.profile);
    const submitted = attempts[1]!.profile;
    expect('views' in submitted.generic && submitted.generic.views.overview.content[0]!.props.text).toEqual({
      en: 'Later overview edit',
      ja: '読書ノート',
    });
    expect(submitted.types[0]!.views!.details!.content[0]!.props).toEqual({
      id: 'details',
      level: 2,
      text: { en: 'Corrected heading', ja: '後からの編集' },
    });
    expect(host.textContent).toContain(m.curation_saved());
    await select('curation-view', 'details');
    await heading('details');
    expect(textField('text.fr')!.value).toBe('');
    await select('curation-template', JSON.stringify({ scope: 'generic', key: null }));
    await select('curation-view', 'overview');
    await heading('overview');
    expect(textField('text.en')!.value).toBe('Later overview edit');
    expect(textField('text.fr')!.value).toBe('');
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 15000);
