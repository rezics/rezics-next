import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import type { PublishInput, PublishResult } from '../src/features/pages/curate';
import type { CurationRead } from '../src/features/pages/curate-actions';
import type { PresentationPreview } from '../src/features/pages/presentation-preview';
import type { CurationEditorTransport } from '../src/features/pages/curate-view-editor';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
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
  const templateControl = (name: string) => {
    const region = [...host.querySelectorAll('section')].find(
      (section) => section.getAttribute('aria-label') === m.curation_templates(),
    );
    return ([...(region?.querySelectorAll('label') ?? [])].find((label) => label.textContent === name)?.control ??
      null) as InstanceType<typeof window.HTMLSelectElement> | null;
  };
  const select = async (name: string, value: string) => {
    await act(async () => {
      const control = templateControl(name)! as InstanceType<typeof window.HTMLSelectElement>;
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
      createElement(
        'div',
        null,
        createElement(Link, { to: '/search' }, 'Search destination'),
        createElement(PresentationViewEditor, {
          initial,
          locale: 'en',
          transport: {
            // Even a matching active read cannot establish an unknown write's outcome.
            read: async () =>
              attempts[0]
                ? {
                    ok: true,
                    reader: initial.reader,
                    profile: attempts[0].profile,
                    digest: profileDigest(attempts[0].profile),
                    head: 8,
                  }
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
    onEnter: () => {
      arrivals++;
    },
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
    expect((templateControl(m.curation_template()) as InstanceType<typeof window.HTMLSelectElement>).value).toBe(
      JSON.stringify({ scope: 'type', key: 'schema:Book' }),
    );
    expect((templateControl(m.curation_view()) as InstanceType<typeof window.HTMLSelectElement>).value).toBe('details');
  };
  try {
    await router.load();
    await act(async () => root.render(createElement(RouterProvider, { router })));
    expect(unloadIsProtected()).toBe(false);
    await select(m.curation_template(), JSON.stringify({ scope: 'type', key: 'schema:Book' }));
    await select(m.curation_view(), 'details');
    await heading('details');
    expect(unloadIsProtected()).toBe(false); // Opening a view is not an edit.
    await edit('text.en', 'Original publication');
    await edit('text.fr', 'Brouillon');
    await edit('text.fr', '');
    expect(unloadIsProtected()).toBe(true);
    const draftDialog = await attemptDeparture();
    expect(draftDialog.textContent).toContain(m.curation_leave_warning());
    await click(m.curation_stay());
    await settle(() => !window.document.querySelector('[role="alertdialog"]'));
    assertSelection();
    expect(textField('text.en')!.value).toBe('Original publication');
    expect(textField('text.fr')!.value).toBe('');
    expect(attempts).toHaveLength(0);
    await click(m.curation_publish());
    await settle(() => !!host.textContent?.includes(m.curation_unknown()));
    expect(attempts).toHaveLength(1);
    const original = structuredClone(attempts[0]!);
    await edit('text.en', 'Later unpublished draft');
    await select(m.curation_view(), 'overview');
    await heading('book');
    await edit('text.en', 'Other view draft');
    await select(m.curation_view(), 'details');
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
    await select(m.curation_view(), 'overview');
    await heading('book');
    expect(textField('text.en')!.value).toBe('Other view draft');
    await select(m.curation_view(), 'details');
    await heading('details');
    expect(textField('text.en')!.value).toBe('Later unpublished draft');
    expect(textField('text.fr')!.value).toBe('');

    // Browser back uses the same transition protocol; Escape means Stay.
    await act(async () => router.history.back());
    await settle(() => !!window.document.querySelector('[role="alertdialog"]'));
    await act(async () => {
      window.document.activeElement?.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
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
    await settle(
      () => !!host.textContent?.includes(m.curation_actual_head({ head: 8, digest: profileDigest(original.profile) })),
    );
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
    await act(async () => {
      await router.navigate({ to: initialLocation });
    });
    await select(m.curation_template(), JSON.stringify({ scope: 'type', key: 'schema:Book' }));
    await select(m.curation_view(), 'details');
    await heading('details');
    await edit('text.en', 'Confirmed publication');
    await click(m.curation_publish());
    await settle(() => !!host.textContent?.includes(m.curation_published({ head: 8 })));
    expect(host.textContent).toContain(m.curation_saved());
    expect(attempts).toHaveLength(3);
    expect(unloadIsProtected()).toBe(false);
    await act(async () => {
      (host.querySelector('a')! as unknown as HTMLElement).click();
    });
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

test('reader replacement and ABA retire delayed reload, publication and preview completions while retaining only the original reader intent', async () => {
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
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
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
  const { PresentationViewEditor } = await import('../src/features/pages/curate-view-editor');
  const { PresentationPreviewPanel } = await import('../src/features/pages/presentation-preview-view');
  const { m } = await import('../src/paraglide/messages.js');
  const readerA = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
  const readerB = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
  const emptyDocument: CompositionDocument = { root: { props: {} }, content: [] };
  const profileFor = (route: string): PresentationProfile => ({
    format: PROFILE_FORMAT,
    generic: emptyDocument,
    bases: [],
    types: [],
    routes: [{ route, document: emptyDocument }],
  });
  const readFor = (reader: string, route: string, head: number): CurationRead => {
    const profile = profileFor(route);
    return { ok: true, reader, profile, digest: profileDigest(profile), head };
  };
  const initial = readFor(readerA, '/a-initial', 7);
  const reads: { reader: string; pending: ReturnType<typeof deferred<CurationRead>> }[] = [];
  const previewReads: { pending: ReturnType<typeof deferred<PresentationPreview>> }[] = [];
  const publishes: {
    reader: string;
    input: PublishInput;
    pending?: ReturnType<typeof deferred<PublishResult>>;
  }[] = [];
  const transport: CurationEditorTransport = {
    read: (reader) => {
      const pending = deferred<CurationRead>();
      reads.push({ reader, pending });
      return pending.promise;
    },
    publish: (input, reader) => {
      if (reader === readerB) {
        publishes.push({ reader, input: structuredClone(input) });
        return Promise.resolve({ ok: true, digest: profileDigest(input.profile), head: input.expectedHead + 1 });
      }
      const pending = deferred<PublishResult>();
      publishes.push({ reader, input: structuredClone(input), pending });
      return pending.promise;
    },
  };
  const readPreview = async (): Promise<PresentationPreview> => {
    const pending = deferred<PresentationPreview>();
    previewReads.push({ pending });
    return pending.promise;
  };
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let subject: string | null = readerA;
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(PresentationViewEditor, {
          initial,
          locale: 'en',
          observedSession: { state: 'signed-in', subject },
          transport,
          preview: createElement(PresentationPreviewPanel, { locale: 'en', read: readPreview }),
        }),
      );
    });
  };
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 150 && !ready(); count++)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(ready()).toBe(true);
  };
  const click = async (label: string) => {
    const control = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === label);
    expect(control).toBeDefined();
    await act(async () => control!.click());
  };
  const inspectPreview = async (route: string) => {
    const preview = [...host.querySelectorAll('section[aria-labelledby]')].find(
      (section) =>
        window.document.getElementById(section.getAttribute('aria-labelledby')!)?.textContent ===
        m.presentation_preview_title(),
    )!;
    const labeledControl = (name: string) => {
      const label = [...preview.querySelectorAll('label')].find((item) => item.textContent === name)!;
      return window.document.getElementById(label.htmlFor)!;
    };
    await act(async () => {
      const kind = labeledControl(m.presentation_preview_target()) as InstanceType<typeof window.HTMLSelectElement>;
      kind.value = 'route';
      kind.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await act(async () => {
      const address = labeledControl(m.presentation_preview_address()) as InstanceType<typeof window.HTMLInputElement>;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(address, route);
      address.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await click(m.presentation_preview_inspect());
  };
  const templateControl = (name: string) => {
    const region = [...host.querySelectorAll('section')].find(
      (section) => section.getAttribute('aria-label') === m.curation_templates(),
    );
    return ([...(region?.querySelectorAll('label') ?? [])].find((label) => label.textContent === name)?.control ??
      null) as InstanceType<typeof window.HTMLSelectElement> | null;
  };
  const switchReader = async (reader: string, readIndex: number, route: string, head: number) => {
    subject = reader;
    await render();
    await settle(() => reads.length > readIndex);
    expect(reads[readIndex]!.reader).toBe(reader);
    reads[readIndex]!.pending.resolve(readFor(reader, route, head));
    await settle(() => templateControl(m.curation_template()) !== null);
  };
  const routeOptions = () =>
    [...templateControl(m.curation_template())!.querySelectorAll('option')].map(
      (option) => option.textContent?.trim() ?? '',
    );
  const expectedRoute = (route: string) => `${m.curation_route()}: ${route}`;
  const previewPage: PresentationPreview = {
    ok: true,
    target: { route: '/late-preview' },
    locale: 'en',
    head: 1,
    page: {
      subject: null,
      profile: `sha256:${'b'.repeat(64)}`,
      template: { scope: 'route', key: '/late-preview' },
      document: { root: { props: {} }, content: [] },
      reads: {},
    },
  };
  try {
    await render();
    expect(templateControl(m.curation_template())).not.toBeNull();
    await click(m.curation_publish());
    await settle(() => publishes.length === 1);
    expect(publishes[0]!.reader).toBe(readerA);

    await inspectPreview('/a-preview');
    await settle(() => previewReads.length === 1);

    await switchReader(readerB, 0, '/b-current', 30);
    expect(routeOptions()).toContain(expectedRoute('/b-current'));
    expect(routeOptions()).not.toContain(expectedRoute('/a-initial'));
    await click(m.curation_reload());
    await settle(() => reads.length === 2);
    await inspectPreview('/b-preview');
    await settle(() => previewReads.length === 2);

    await switchReader(readerA, 2, '/a-current', 40);
    const curationSelect = templateControl(m.curation_template()) as InstanceType<typeof window.HTMLSelectElement>;
    curationSelect.focus();
    const focusedA = window.document.activeElement;
    const statusesA = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    publishes[0]!.pending!.resolve({ ok: true, digest: profileDigest(publishes[0]!.input.profile), head: 8 });
    previewReads[0]!.pending.resolve(previewPage);
    reads[1]!.pending.resolve(readFor(readerB, '/b-late-reload', 88));
    previewReads[1]!.pending.resolve({ ok: false, reason: 'unavailable' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(window.document.activeElement).toBe(focusedA);
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(statusesA);
    expect(routeOptions()).toContain(expectedRoute('/a-current'));
    expect(routeOptions()).not.toContain(expectedRoute('/b-late-reload'));
    expect(host.textContent).not.toContain(m.presentation_editor_published());
    expect(host.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();
    expect(host.textContent).not.toContain(m.presentation_preview_unavailable());
    expect(host.textContent).toContain(m.curation_unknown());
    expect(publishes).toHaveLength(1);

    await click(m.curation_reload_head());
    await settle(() => reads.length === 4);
    await switchReader(readerB, 4, '/b-again', 31);
    reads[3]!.pending.reject(new TypeError('obsolete recovery read'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(routeOptions()).toContain(expectedRoute('/b-again'));
    expect(host.textContent).not.toContain(m.curation_unavailable());
    expect(host.textContent).not.toContain(m.presentation_editor_published());

    await switchReader(readerA, 5, '/a-recovered', 41);
    expect(host.textContent).toContain(m.curation_unknown());
    await click(m.curation_retry_original());
    await settle(() => publishes.length === 2);
    expect(publishes[1]!.reader).toBe(readerA);
    expect(publishes[1]!.input).toEqual(publishes[0]!.input);

    await switchReader(readerB, 6, '/b-ready', 32);
    const focusedB = templateControl(m.curation_template()) as InstanceType<typeof window.HTMLSelectElement>;
    focusedB.focus();
    const statusesB = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    publishes[1]!.pending!.resolve({ ok: false, reason: 'unavailable', outcome: 'unknown' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(window.document.activeElement).toBe(focusedB);
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(statusesB);
    expect(routeOptions()).toContain(expectedRoute('/b-ready'));
    expect(routeOptions()).not.toContain(expectedRoute('/a-current'));
    expect(publishes).toHaveLength(2);

    await click(m.curation_publish());
    await settle(() => publishes.length === 3);
    expect(publishes[2]!.reader).toBe(readerB);
    expect(publishes[2]!.input.keys.publish).not.toBe(publishes[0]!.input.keys.publish);
    expect(publishes[2]!.input.keys.activate).not.toBe(publishes[0]!.input.keys.activate);
    await settle(() => host.textContent?.includes(m.presentation_editor_published()) ?? false);
    expect(routeOptions()).toContain(expectedRoute('/b-ready'));
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
