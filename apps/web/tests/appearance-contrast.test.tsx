import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';

test('A reader can choose and retain higher contrast in the existing appearance controls', async () => {
  // Default controls, real menus and the actual inline bootstrap; no native service or component mocks.
  // The DOM establishes preference behavior, not visual or measured WCAG conformance.
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const queries = new Map<string, ReturnType<typeof query>>();
  function query(media: string, matches = false, legacy = false) {
    const listeners = new Set<() => void>();
    return {
      media,
      matches,
      listeners,
      addEventListener: legacy ? undefined : (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: legacy ? undefined : (_: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      change(matches: boolean) {
        this.matches = matches;
        for (const listener of listeners) listener();
      },
    };
  }
  const contrastQuery = '(prefers-contrast: more)';
  const darkQuery = '(prefers-color-scheme: dark)';
  queries.set(contrastQuery, query(contrastQuery));
  queries.set(darkQuery, query(darkQuery));
  window.matchMedia = (media: string) => {
    if (!queries.has(media)) queries.set(media, query(media));
    return queries.get(media)!;
  };
  const globals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'MutationObserver',
    'ResizeObserver',
    'Event',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'FocusEvent',
    'CSS',
    'getComputedStyle',
    'matchMedia',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    const value = key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { act } = await import('react');
  const { hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { AppearanceControls } = await import('../src/shell/appearance-controls');
  const { PreferencesScript } = await import('../src/shell/preferences-script');
  const { setLocale, locales } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = createRequire(require.resolve('storybook/test'));
  const { within } = await import(storybook.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const html = window.document.documentElement;
  setLocale('en', { reload: false });
  html.lang = 'en';
  const route = createRootRoute({
    component: () => (
      <>
        <PreferencesScript />
        <AppearanceControls />
        <AppearanceControls />
      </>
    ),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en'] }) });
  await router.load();
  const composition = <RouterProvider router={router} />;
  let root: ReturnType<typeof hydrateRoot> | undefined;
  const body = within(window.document.body);
  const regions = () => within(host).getAllByRole('region', { name: m.shell_appearance() });
  const trigger = (index: number) => within(regions()[index]!).getByRole('button', { name: m.shell_theme() });
  async function openContrast(index = 0) {
    await act(async () => user.click(trigger(index)));
    // The original three theme choices remain on the first menu level.
    expect(body.getAllByRole('menuitemradio')).toHaveLength(3);
    await act(async () => user.click(body.getByRole('menuitem', { name: m.shell_contrast() })));
    return within(
      (await body.findByRole('menuitemradio', { name: m.shell_contrast_more() })).closest('[role="menu"]')!,
    );
  }
  const labels = {
    system: m.shell_contrast_system(),
    standard: m.shell_contrast_standard(),
    more: m.shell_contrast_more(),
  };
  async function choose(value: keyof typeof labels, index = 0, current?: keyof typeof labels) {
    const menu = await openContrast(index);
    expect(menu.getAllByRole('menuitemradio')).toHaveLength(3);
    if (current)
      expect(menu.getByRole('menuitemradio', { name: labels[current] }).getAttribute('aria-checked')).toBe('true');
    await act(async () => user.click(menu.getByRole('menuitemradio', { name: labels[value] })));
  }
  try {
    window.document.cookie = 'rezics_theme=dark; Path=/';
    window.document.cookie = 'rezics_contrast=more; Path=/';
    window.document.cookie = 'rezics_locale=en; Path=/';
    window.document.cookie = 'rezics_nav=collapsed; Path=/';
    const markup = renderToString(composition);
    window.document.cookie = 'rezics_contrast=standard; Path=/';
    window.document.cookie = 'rezics_theme=light; Path=/';
    expect(renderToString(composition)).toBe(markup);
    host.innerHTML = markup;
    for (const button of host.querySelectorAll<HTMLButtonElement>('button')) expect(button.disabled).toBe(true);
    const bootstrap = host.querySelector('script[data-preferences]')!.textContent!;
    const reload = () => {
      html.removeAttribute('data-contrast');
      html.classList.remove('light', 'dark');
      window.eval(bootstrap);
    };
    reload();
    expect(html.dataset.contrast).toBe('standard');
    expect(html.classList.contains('light')).toBe(true);
    expect(html.dataset.nav).toBe('collapsed');
    await act(async () => {
      root = hydrateRoot(host, composition);
    });
    expect(trigger(0).disabled).toBe(false);
    expect(trigger(1).disabled).toBe(false);
    await choose('more', 0, 'standard');
    expect(window.document.cookie).toContain('rezics_contrast=more');
    expect(html.dataset.contrast).toBe('more');
    await act(async () => queries.get(contrastQuery)?.change(false));
    expect(html.dataset.contrast).toBe('more');
    // A second mounted region sees the same choice and can change it.
    await choose('standard', 1, 'more');
    await act(async () => queries.get(contrastQuery)?.change(true));
    expect(html.dataset.contrast).toBe('standard');
    await choose('system', 0, 'standard');
    expect(window.document.cookie).toContain('rezics_contrast=system');
    expect(html.dataset.contrast).toBe('more');
    await act(async () => queries.get(contrastQuery)!.change(false));
    expect(html.dataset.contrast).toBe('standard');
    await act(async () => queries.get(contrastQuery)!.change(true));
    expect(html.dataset.contrast).toBe('more');
    await choose('more', 1, 'system');
    expect(queries.get(contrastQuery)!.listeners.size).toBe(0);
    expect(html.classList.contains('light')).toBe(true);
    expect(window.document.cookie).toContain('rezics_locale=en');

    await act(async () => root!.unmount());
    root = undefined;
    reload();
    expect(html.dataset.contrast).toBe('more');
    host.innerHTML = markup;
    await act(async () => {
      root = hydrateRoot(host, composition);
    });
    await choose('system', 0, 'more');
    await act(async () => root!.unmount());
    root = undefined;
    expect(queries.get(contrastQuery)!.listeners.size).toBe(0);

    // Unknown values fall back to system, including legacy media-query listeners.
    queries.set(contrastQuery, query(contrastQuery, true, true));
    window.document.cookie = 'rezics_contrast=unknown; Path=/';
    window.document.cookie = 'rezics_theme=system; Path=/';
    reload();
    expect(html.dataset.contrast).toBe('more');
    host.innerHTML = markup;
    await act(async () => {
      root = hydrateRoot(host, composition);
    });
    await act(async () => queries.get(contrastQuery)!.change(false));
    expect(html.dataset.contrast).toBe('standard');
    await act(async () => queries.get(darkQuery)!.change(true));
    expect(html.classList.contains('dark')).toBe(true);
    await choose('standard', 1, 'system');
    await act(async () => root!.unmount());
    root = undefined;
    expect(queries.get(contrastQuery)!.listeners.size).toBe(0);
    expect(queries.get(darkQuery)!.listeners.size).toBe(0);
    // No mounted control retains its synchronization listener after unmount.
    html.dataset.contrast = 'standard';
    window.document.cookie = 'rezics_contrast=more; Path=/';
    window.dispatchEvent(new window.Event('rezics:contrast'));
    expect(html.dataset.contrast).toBe('standard');
    reload();
    expect(html.dataset.contrast).toBe('more');

    window.matchMedia = undefined;
    Object.defineProperty(globalThis, 'matchMedia', { configurable: true, writable: true, value: undefined });
    window.document.cookie = 'rezics_theme=system; Path=/';
    window.document.cookie = 'rezics_contrast=system; Path=/';
    reload();
    expect(html.dataset.contrast).toBe('standard');
    expect(html.classList.contains('light')).toBe(true);
    expect(html.dataset.nav).toBe('collapsed');
    window.document.cookie = 'rezics_theme=dark; Path=/';
    window.document.cookie = 'rezics_contrast=more; Path=/';
    reload();
    expect(html.classList.contains('dark')).toBe(true);
    expect(html.dataset.contrast).toBe('more');

    for (const locale of locales) {
      const own = [m.shell_contrast, m.shell_contrast_system, m.shell_contrast_standard, m.shell_contrast_more].map(
        (message) => message({}, { locale }),
      );
      expect(new Set(own).size).toBe(4);
      for (const label of own) expect(label.length).toBeGreaterThan(0);
    }
  } finally {
    if (root) await act(async () => root!.unmount());
    setLocale('en', { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
