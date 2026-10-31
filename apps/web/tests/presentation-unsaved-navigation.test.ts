import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import type { PublishInput } from '../src/features/pages/curate';

test('default presentation editor protects unsaved drafts and unresolved publication when leaving and preserves edits when staying', async () => {
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
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } = await import('@tanstack/react-router');
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
  const initial = { ok: true as const, profile, head: 7, digest: profileDigest(profile) };
  const attempts: PublishInput[] = [];
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const lookupButton = (label: string) =>
    [...(window.document.querySelector('[role="alertdialog"]') ?? host).querySelectorAll('button')].find(
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
  let arrivals = 0;
  let confirmWrites = false;
  const initialLocation = '/curate/presentation';
  const rootRoute = createRootRoute({ component: Outlet });
  const editorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: initialLocation,
    component: () =>
      createElement('div', null,
        createElement(Link, { to: '/search' }, 'Search destination'),
        createElement(PresentationViewEditor, {
          initial,
          locale: 'en',
          transport: {
            // Even a matching active read cannot establish an unknown write's outcome.
            read: async () => attempts[0]
              ? { ok: true, profile: attempts[0].profile, digest: profileDigest(attempts[0].profile), head: 8 }
              : initial,
            publish: async (input) => {
              attempts.push(structuredClone(input));
              return confirmWrites
                ? { ok: true, digest: profileDigest(input.profile), head: input.expectedHead + 1 }
                : { ok: false, reason: 'unavailable', outcome: 'unknown' };
            },
          },
        }),
      ),
  });
  const destinationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/search',
    onEnter: () => { arrivals++; },
    component: () => createElement('h1', null, 'Actual search destination'),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([editorRoute, destinationRoute]),
    history: createMemoryHistory({ initialEntries: ['/search', initialLocation] }),
  });
  const attemptDeparture = async () => {
    await act(async () => {
      (host.querySelector('a')! as unknown as HTMLElement).focus();
      (host.querySelector('a')! as unknown as HTMLElement).click();
    });
    await settle(() => !!window.document.querySelector('[role="alertdialog"]'));
    expect(router.state.location.pathname).toBe(initialLocation);
    expect(arrivals).toBe(0);
    const dialog = window.document.querySelector('[role="alertdialog"]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    return dialog;
  };
  const unloadIsProtected = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const assertSelection = () => {
    expect((host.querySelector('#curation-template') as InstanceType<typeof window.HTMLSelectElement>).value)
      .toBe(JSON.stringify({ scope: 'type', key: 'schema:Book' }));
    expect((host.querySelector('#curation-view') as InstanceType<typeof window.HTMLSelectElement>).value).toBe('details');
  };
  try {
    await router.load();
    await act(async () => root.render(createElement(RouterProvider, { router })));
    expect(unloadIsProtected()).toBe(false);
    await select('curation-template', JSON.stringify({ scope: 'type', key: 'schema:Book' }));
    await select('curation-view', 'details');
    await heading('details');
    expect(unloadIsProtected()).toBe(false); // Opening a view is not an edit.
    await edit('text.en', 'Original publication');
    await edit('text.fr', 'Brouillon');
    await edit('text.fr', '');
    expect(unloadIsProtected()).toBe(true);
    await click(m.curation_publish());
    await settle(() => !!host.textContent?.includes(m.curation_unknown()));
    expect(attempts).toHaveLength(1);
    const original = structuredClone(attempts[0]!);
    await edit('text.en', 'Later unpublished draft');
    await select('curation-view', 'overview');
    await heading('book');
    await edit('text.en', 'Other view draft');
    await select('curation-view', 'details');
    await heading('details');

    const dialog = await attemptDeparture();
    expect(dialog.textContent).toContain(m.curation_leave_recovery());
    await click(m.curation_stay());
    await settle(() => !window.document.querySelector('[role="alertdialog"]'));
    await settle(() => window.document.activeElement === host.querySelector('a'));
    assertSelection();
    expect(textField('text.en')!.value).toBe('Later unpublished draft');
    expect(textField('text.fr')!.value).toBe('');
    expect(attempts).toEqual([original]);
    await select('curation-view', 'overview');
    await heading('book');
    expect(textField('text.en')!.value).toBe('Other view draft');
    await select('curation-view', 'details');
    await heading('details');
    expect(textField('text.en')!.value).toBe('Later unpublished draft');
    expect(textField('text.fr')!.value).toBe('');

    // Browser back uses the same transition protocol; Escape means Stay.
    await act(async () => router.history.back());
    await settle(() => !!window.document.querySelector('[role="alertdialog"]'));
    await act(async () => {
      window.document.activeElement?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(() => !window.document.querySelector('[role="alertdialog"]'));
    expect(router.state.location.pathname).toBe(initialLocation);
    assertSelection();
    expect(textField('text.en')!.value).toBe('Later unpublished draft');
    expect(textField('text.fr')!.value).toBe('');
    expect(attempts).toEqual([original]);

    // Only an explicit retry sends the identical retained body and idempotency keys.
    await click(m.curation_retry_original());
    await settle(() => attempts.length === 2);
    expect(attempts).toEqual([original, original]);
    await click(m.curation_reload_head());
    await settle(() => !!host.textContent?.includes(m.curation_actual_head({ head: 8, digest: profileDigest(original.profile) })));
    expect(attempts).toEqual([original, original]);
    // Clearing the visible draft still leaves mounted unknown-outcome recovery to protect.
    await click(m.curation_view_discard());
    await settle(() => !!window.document.querySelector('[role="alertdialog"]'));
    await click(m.curation_view_discard());
    await settle(() => !window.document.querySelector('[role="alertdialog"]'));
    expect(host.textContent).toContain(m.curation_saved());
    expect(unloadIsProtected()).toBe(true);
    const leaveDialog = await attemptDeparture();
    expect(leaveDialog.textContent).toContain(m.curation_leave_recovery());
    await click(m.curation_leave());
    await settle(() => router.state.location.pathname === '/search');
    expect(host.textContent).toContain('Actual search destination');
    expect(arrivals).toBe(1);
    expect(attempts).toEqual([original, original]);
    expect(unloadIsProtected()).toBe(false);

    // A confirmed publication with no later draft removes both exit protections.
    confirmWrites = true;
    await act(async () => { await router.navigate({ to: initialLocation }); });
    await select('curation-template', JSON.stringify({ scope: 'type', key: 'schema:Book' }));
    await select('curation-view', 'details');
    await heading('details');
    await edit('text.en', 'Confirmed publication');
    await click(m.curation_publish());
    await settle(() => !!host.textContent?.includes(m.curation_published({ head: 8 })));
    expect(host.textContent).toContain(m.curation_saved());
    expect(attempts).toHaveLength(3);
    expect(unloadIsProtected()).toBe(false);
    await act(async () => { (host.querySelector('a')! as unknown as HTMLElement).click(); });
    await settle(() => router.state.location.pathname === '/search');
    expect(arrivals).toBe(2);
    expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(attempts).toHaveLength(3);
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
