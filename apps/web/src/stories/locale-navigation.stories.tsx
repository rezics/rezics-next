import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useBlocker,
  useLocation,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import { getLocale, locales, setLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppearanceControls } from '../shell/appearance-controls';
import { LocaleNavigationProvider } from '../shell/locale-navigation/context';
import type { LocaleNavigationContextValue } from '../shell/locale-navigation/context';
import type { Locale, LocaleNavigationLocation } from '../shell/locale-navigation/routing';

type Journey = 'success' | 'canceled' | 'recovery';
const initialLocation = '/en/subjects/reader-01?view=latest&return_to=%2Fsearch%3Fq%3Dmoon#chapter-4';

function localeAt(pathname: string): Locale {
  const prefix = pathname.split('/')[1];
  return locales.find((locale) => locale === prefix) ?? 'en';
}

function visit(
  location: {
    pathname: string;
    searchStr: string;
    hash: string;
    href: string;
    state: unknown;
  },
  supported: boolean,
): LocaleNavigationLocation {
  const state = location.state;
  const key = state !== null && typeof state === 'object' ? (state as { __TSR_key?: unknown }).__TSR_key : undefined;
  return {
    pathname: location.pathname,
    searchStr: location.searchStr,
    hash: location.hash && !location.hash.startsWith('#') ? `#${location.hash}` : location.hash,
    locale: localeAt(location.pathname),
    visitKey: typeof key === 'string' ? key : location.href,
    supported,
  };
}

function ReaderSurface({ journey }: { journey: Journey }) {
  const location = useLocation();
  const [dirty, setDirty] = useState(journey === 'canceled');
  const blocker = useBlocker({ shouldBlockFn: () => dirty, withResolver: true, enableBeforeUnload: false });
  return (
    <main className="space-y-4 rounded-2xl border border-border p-4">
      <h1 className="text-lg font-semibold">Subject reader route</h1>
      <p className="break-all text-sm text-muted-foreground">
        Reader location:{' '}
        <code>
          {location.pathname}
          {location.searchStr}
          {location.hash}
        </code>
      </p>
      <button
        type="button"
        className="min-h-11 rounded-lg border border-border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setDirty((value) => !value)}
      >
        {dirty ? 'Draft is dirty' : 'Mark reader draft dirty'}
      </button>
      {blocker.status === 'blocked' ? (
        <section
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="locale-departure-title"
          className="space-y-3 rounded-xl border border-border p-4"
        >
          <h2 id="locale-departure-title" className="font-semibold">
            Leave this reader?
          </h2>
          <p className="text-sm">The current editor asks before leaving this page.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="min-h-11 rounded-lg border border-border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => blocker.reset?.()}
            >
              Stay here
            </button>
            <button
              type="button"
              className="min-h-11 rounded-lg bg-primary px-3 text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => blocker.proceed?.()}
            >
              Leave reader
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function ReaderShell({ journey, children }: { journey: Journey; children?: ReactNode }) {
  const router = useRouter();
  const snapshot = useRouterState({
    select: (state) => state.location,
  });
  const readCurrentLocation = () => visit(router.state.location, true);
  const location = visit(snapshot, true);
  const value: LocaleNavigationContextValue = {
    location,
    readCurrentLocation,
    navigate: async (href) => {
      if (journey === 'recovery') throw new Error('The destination could not be loaded');
      await router.navigate({ href });
      return readCurrentLocation();
    },
    revalidate: () => router.invalidate(),
    commitLocale: (locale) => setLocale(locale, { reload: false }),
  };
  return (
    <LocaleNavigationProvider value={value}>
      <div className="mx-auto max-w-3xl space-y-5 p-3 sm:p-6">
        <AppearanceControls />
        <p className="text-xs text-muted-foreground">
          {m.shell_language_page_destination({}, { locale: location.locale })}
        </p>
        {children}
        <Outlet />
      </div>
    </LocaleNavigationProvider>
  );
}

function LocaleJourney({ journey }: { journey: Journey }) {
  const [router] = useState(() => {
    const root = createRootRoute({ component: () => <ReaderShell journey={journey} /> });
    return createRouter({
      routeTree: root.addChildren(
        locales.map((locale) =>
          createRoute({
            getParentRoute: () => root,
            path: `/${locale}/subjects/$id`,
            component: () => <ReaderSurface journey={journey} />,
          }),
        ),
      ),
      history: createMemoryHistory({ initialEntries: [initialLocation] }),
    });
  });
  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Patterns/Locale navigation',
  component: LocaleJourney,
  args: { journey: 'success' },
  parameters: {
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' }, type: 'desktop' },
      },
    },
    docs: {
      description: {
        story:
          'Review the mounted reader journey at phone390 and desktop1440 in both themes. The language menu uses keyboard focus and the existing route departure guard.',
      },
    },
  },
  beforeEach: () => {
    const previous = /(?:^|;\s*)rezics_locale=([^;]*)/.exec(document.cookie)?.[1];
    setLocale('en', { reload: false });
    return () => {
      document.cookie = `rezics_locale=${previous ?? ''}; ${previous === undefined ? 'Max-Age=0;' : ''} Path=/; SameSite=Lax`;
    };
  },
} satisfies Meta<typeof LocaleJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

async function chooseJapanese(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);
  const trigger = canvas.getByRole('button', { name: /Language: English/ });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  const japanese = await body.findByRole('menuitemradio', { name: /日本語/ });
  japanese.focus();
  await userEvent.keyboard('{Enter}');
  return { canvas, body, trigger };
}

export const SameReader: Story = {
  args: { journey: 'success' },
  play: async ({ canvasElement }) => {
    const { canvas } = await chooseJapanese(canvasElement);
    await expect(await canvas.findByText(/\/ja\/subjects\/reader-01\?view=latest/)).toBeVisible();
  },
};

export const CanceledDeparture: Story = {
  args: { journey: 'canceled' },
  play: async ({ canvasElement }) => {
    const { canvas, body } = await chooseJapanese(canvasElement);
    await body.findByRole('alertdialog');
    await userEvent.click(body.getByRole('button', { name: 'Stay here' }));
    await expect(await canvas.findByText(/\/en\/subjects\/reader-01\?view=latest/)).toBeVisible();
  },
};

export const NavigationRecovery: Story = {
  args: { journey: 'recovery' },
  play: async ({ canvasElement }) => {
    const { body } = await chooseJapanese(canvasElement);
    const failure = await body.findByRole('alert');
    await expect(failure.textContent).toContain('Could not open Japanese');
    await expect(within(failure).getByRole('link', { name: /Continue this page in English/ })).toHaveAttribute(
      'href',
      initialLocation,
    );
  },
};
