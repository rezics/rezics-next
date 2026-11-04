import { createRequire } from 'node:module';
import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import type { LocaleNavigationContextValue } from '../src/shell/locale-navigation/context';
import type { Locale, LocaleNavigationLocation } from '../src/shell/locale-navigation/routing';

const entry = '/en/subjects/reader-01?view=latest&return_to=%2Fsearch%3Fq%3D%E6%9C%88#chapter-4';
const localeCodes = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;

function visit(
  location: { pathname: string; searchStr: string; hash: string; href: string; state: unknown },
  supported: boolean,
): LocaleNavigationLocation {
  const routeState = location.state;
  const key =
    routeState !== null && typeof routeState === 'object' ? (routeState as { __TSR_key?: unknown }).__TSR_key : undefined;
  const pathLocale = location.pathname.split('/')[1];
  const locale = localeCodes.find((candidate) => candidate === pathLocale);
  return {
    pathname: location.pathname,
    searchStr: location.searchStr,
    hash: location.hash && !location.hash.startsWith('#') ? `#${location.hash}` : location.hash,
    locale: (locale ?? 'en') as Locale,
    visitKey: typeof key === 'string' ? key : location.href,
    supported,
  };
}

type ReaderFixture = {
  window: any;
  router: any;
  root: any;
  act: any;
  user: any;
  body: any;
  waitFor: any;
  admissions: string[];
  committedLocales: Locale[];
  setDraft: (dirty: boolean) => void;
  setCanLeave: (value: boolean) => void;
  confirmCount: () => number;
  entry: string;
};

async function withReader(run: (fixture: ReaderFixture) => Promise<void>) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.invalid${entry}` });
  window.confirm = (() => true) as typeof window.confirm;
  window.scrollTo = () => {};
  window.matchMedia = ((media: string) => ({
    media,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as typeof window.matchMedia;
  const globals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLFormElement',
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
    'scrollTo',
    'IS_REACT_ACT_ENVIRONMENT',
    'confirm',
  ];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    const value =
      key === 'window'
        ? window
        : key === 'IS_REACT_ACT_ENVIRONMENT'
          ? true
          : key === 'confirm'
            ? window.confirm.bind(window)
            : window[key as keyof typeof window];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const { act, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
    useBlocker,
    useRouter,
    useRouterState,
  } =
    await import('@tanstack/react-router');
  const { deriveLocaleDestinations } = await import('../src/shell/locale-navigation/routing');
  const { LocaleNavigationProvider } = await import('../src/shell/locale-navigation/context');
  const { AppearanceControls } = await import('../src/shell/appearance-controls');
  const storybook = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(storybook.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  window.document.documentElement.lang = 'en';
  let canLeave = true;
  let confirmCount = 0;
  let setDraft: (dirty: boolean) => void = () => {};
  const admissions: string[] = [];
  const committedLocales: Locale[] = [];

  function LocaleHarness({ children }: { children: ReactNode }) {
    const router = useRouter();
    const snapshot = useRouterState({
      select: (state) => ({
        location: state.location,
      }),
    });
    const readCurrentLocation = () => visit(router.state.location, true);
    const value: LocaleNavigationContextValue = {
      location: visit(snapshot.location, true),
      readCurrentLocation,
      navigate: async (href) => {
        await router.navigate({ href });
        return readCurrentLocation();
      },
      revalidate: async () => {
        await router.invalidate();
      },
      commitLocale: (locale) => {
        committedLocales.push(locale);
      },
    };
    return <LocaleNavigationProvider value={value}>{children}</LocaleNavigationProvider>;
  }

  function SubjectReader() {
    const [dirty, updateDirty] = useState(false);
    setDraft = updateDirty;
    useBlocker({
      shouldBlockFn: () => {
        if (!dirty) return false;
        confirmCount++;
        return !window.confirm('Leave this page?');
      },
      enableBeforeUnload: false,
    });
    return (
      <main>
        <h1>Subject reader route</h1>
        <button onClick={() => updateDirty(true)}>Make draft dirty</button>
        <button onClick={() => updateDirty(false)}>Discard draft</button>
      </main>
    );
  }

  const rootRoute = createRootRoute({
    component: () => (
      <LocaleHarness>
        <AppearanceControls />
        <Outlet />
      </LocaleHarness>
    ),
  });
  const subjectRoutes = localeCodes.map((locale) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${locale}/subjects/$id`,
      loader: () => {
        admissions.push(locale);
      },
      component: SubjectReader,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(subjectRoutes),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  const root = createRoot(host);
  await act(async () => {
    await router.load();
    expect(router.state.location.pathname).toBe('/en/subjects/reader-01');
    expect(router.state.location.searchStr).toBe('?view=latest&return_to=%2Fsearch%3Fq%3D%E6%9C%88');
    expect(router.state.location.hash).toBe('chapter-4');
    expect(router.state.matches.length).toBeGreaterThan(1);
    expect(deriveLocaleDestinations(visit(router.state.location, true), true).find(({ locale }) => locale === 'ja')).toMatchObject({
      href: '/ja/subjects/reader-01?view=latest&return_to=%2Fsearch%3Fq%3D%E6%9C%88#chapter-4',
      kind: 'page',
    });
    root.render(<RouterProvider router={router} />);
  });
  const body = within(window.document.body);
  const fixture = {
    window,
    router,
    root,
    act,
    user,
    body,
    waitFor,
    admissions,
    committedLocales,
    setDraft,
    setCanLeave(value: boolean) {
      canLeave = value;
      window.confirm = (() => {
        confirmCount++;
        return canLeave;
      }) as typeof window.confirm;
      Object.defineProperty(globalThis, 'confirm', { configurable: true, writable: true, value: window.confirm });
    },
    confirmCount: () => confirmCount,
    entry,
  };
  try {
    await run(fixture);
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('keyboard switching keeps the reader query and fragment; staying in a dirty editor keeps its language', async () => {
  await withReader(async ({ router, body, user, act, waitFor, admissions, committedLocales, setDraft, setCanLeave, confirmCount }) => {
    const button = () => body.getByRole('button', { name: /言語|Language/ });
    const trigger = button();
    trigger.focus();
    await act(async () => user.keyboard('{Enter}'));
    const japanese = await body.findByRole('menuitemradio', { name: /日本語/ });
    japanese.focus();
    await act(async () => user.keyboard('{Enter}'));

    await waitFor(() => expect(router.state.location.pathname).toBe('/ja/subjects/reader-01'));
    expect(body.getByRole('heading', { name: 'Subject reader route' })).toBeDefined();
    expect(router.state.location.searchStr).toBe('?view=latest&return_to=%2Fsearch%3Fq%3D%E6%9C%88');
    expect(router.state.location.hash).toBe('chapter-4');
    expect(committedLocales).toEqual(['ja']);
    await waitFor(() => expect(admissions).toContain('ja'));
    expect(button().getAttribute('aria-label')).toContain('日本語');

    await act(async () => setDraft(true));
    setCanLeave(false);
    const updatedTrigger = button();
    updatedTrigger.focus();
    await act(async () => user.keyboard('{Enter}'));
    const traditional = await body.findByRole('menuitemradio', { name: /繁體中文/ });
    traditional.focus();
    await act(async () => user.keyboard('{Enter}'));
    await waitFor(() => expect(confirmCount()).toBeGreaterThan(0));

    expect(router.state.location.pathname).toBe('/ja/subjects/reader-01');
    expect(committedLocales).toEqual(['ja']);
    expect(button().getAttribute('aria-label')).toContain('日本語');
    expect(body.queryByRole('alert')).toBeNull();
  });
});

test('navigation failure offers the current safe reader and an obsolete completion cannot replace a newer visit', async () => {
  await withReader(async ({ router, body, user, act, waitFor, committedLocales }) => {
    const originalNavigate = router.navigate.bind(router);
    Object.defineProperty(router, 'navigate', {
      configurable: true,
      writable: true,
      value: () => Promise.reject(new Error('navigation unavailable')),
    });
    const trigger = () => body.getByRole('button', { name: /Language|言語/ });
    trigger().focus();
    await act(async () => user.keyboard('{Enter}'));
    const japanese = await body.findByRole('menuitemradio', { name: /日本語/ });
    japanese.focus();
    await act(async () => user.keyboard('{Enter}'));
    const failure = await body.findByRole('alert');
    expect(failure.textContent).toContain('日本語');
    expect(failure.querySelector('a')?.getAttribute('href')).toBe(entry);
    expect(committedLocales).toEqual([]);

    Object.defineProperty(router, 'navigate', {
      configurable: true,
      writable: true,
      value: originalNavigate,
    });
    let resolveOld!: () => void;
    Object.defineProperty(router, 'navigate', {
      configurable: true,
      writable: true,
      value: (options: { href: string }) =>
        options.href.startsWith('/zh-Hant/')
          ? new Promise<void>((resolve) => {
              resolveOld = resolve;
            })
          : originalNavigate(options as never),
    });

    const enTrigger = trigger();
    enTrigger.focus();
    await act(async () => user.keyboard('{Enter}'));
    const traditional = await body.findByRole('menuitemradio', { name: /繁體中文/ });
    traditional.focus();
    await act(async () => user.keyboard('{Enter}'));
    await body.findByRole('status');

    await act(async () => {
      await originalNavigate({ href: '/en/subjects/reader-02' });
    });
    await waitFor(() => expect(body.queryByRole('status')).toBeNull());
    const englishTrigger = trigger();
    englishTrigger.focus();
    await act(async () => user.keyboard('{Enter}'));
    const nextLanguage = await body.findByRole('menuitemradio', { name: /日本語/ });
    nextLanguage.focus();
    await act(async () => user.keyboard('{Enter}'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/ja/subjects/reader-02'));

    await act(async () => resolveOld());
    await waitFor(() => expect(trigger().getAttribute('aria-label')).toContain('日本語'));
    expect(router.state.location.pathname).toBe('/ja/subjects/reader-02');
    expect(committedLocales).toEqual(['ja']);
    Object.defineProperty(router, 'navigate', {
      configurable: true,
      writable: true,
      value: originalNavigate,
    });
  });
});
