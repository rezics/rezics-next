import type { Decorator, Preview } from '@storybook/react-vite';
import { useLayoutEffect } from 'react';
import { spyOn } from 'storybook/test';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { messages as shell } from '../features/shell/messages.ts';
import shellZhHans from '../features/shell/messages/zh-Hans.ts';
import { ShellProvider } from '../features/shell/shell-provider.tsx';
import type { UiLocale } from '../i18n/define.ts';
import '../app/styles.css';
import { type StoryRoute, StoryRouteContext } from './next-navigation.ts';

// Stories read types from the registry Main serves, as the locale layout seeds it in the app.
seedServedTypes();

type Globals = { theme?: 'light' | 'dark'; locale?: UiLocale };

// The app sets <html lang> and the theme class on the server; stories set them
// from the toolbar globals, then provide the route and shell context.
const withDocument: Decorator = (Story, { globals, parameters }) => {
  const { theme = 'light', locale = 'en' } = globals as Globals;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.style.colorScheme = theme;
    document.body.style.fontFamily = 'var(--font-sans)';
  }, [theme, locale]);
  const route = (parameters.route ?? { pathname: '/' }) as StoryRoute;
  return (
    <StoryRouteContext value={route}>
      <ShellProvider
        key={`${theme}-${locale}`}
        locale={locale}
        messages={locale === 'zh-Hans' ? { ...shell, ...shellZhHans } : shell}
        initialTheme={theme}
        initialCollapsed={Boolean(parameters.navCollapsed)}
      >
        <div className="min-h-dvh bg-background font-sans text-foreground">
          <Story />
        </div>
      </ShellProvider>
    </StoryRouteContext>
  );
};

const preview: Preview = {
  // The iframe owns Storybook's address. App history updates (e.g. a saved
  // manuscript revision) belong to the route stand-in, just like next/router.
  beforeEach() {
    const original = window.history.replaceState.bind(window.history);
    const replaceState = spyOn(window.history, 'replaceState').mockImplementation((data, unused, url) => {
      // Anchors still exercise deep links, while pathname/query stay on the iframe.
      const target = new URL(url ?? window.location.href, window.location.href);
      original(data, unused, `${window.location.pathname}${window.location.search}${target.hash}`);
    });
    return () => replaceState.mockRestore();
  },
  decorators: [withDocument],
  parameters: {
    layout: 'fullscreen',
    a11y: { test: 'error' },
    viewport: {
      options: {
        phone: {
          name: 'Phone (390 × 844)',
          styles: { width: '390px', height: '844px' },
          type: 'mobile',
        },
        desktop: {
          name: 'Desktop (1280 × 860)',
          styles: { width: '1280px', height: '860px' },
          type: 'desktop',
        },
        foldCover: { name: 'Fold cover (412 × 960)', styles: { width: '412px', height: '960px' }, type: 'mobile' },
        tabletPortrait: { name: 'Tablet portrait (820 × 1180)', styles: { width: '820px', height: '1180px' }, type: 'tablet' },
        tabletLandscape: { name: 'Tablet landscape (1180 × 820)', styles: { width: '1180px', height: '820px' }, type: 'tablet' },
        foldInner: { name: 'Fold inner (984 × 1092)', styles: { width: '984px', height: '1092px' }, type: 'tablet' },
        phoneLandscape: { name: 'Phone landscape (844 × 390)', styles: { width: '844px', height: '390px' }, type: 'mobile' },
        desktopWide: { name: 'Desktop wide (1920 × 1080)', styles: { width: '1920px', height: '1080px' }, type: 'desktop' },
      },
    },
  },
  globalTypes: {
    theme: {
      description: 'Color theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        dynamicTitle: true,
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
      },
    },
    locale: {
      description: 'Interface locale',
      toolbar: {
        title: 'Locale',
        icon: 'globe',
        dynamicTitle: true,
        items: [
          { value: 'en', title: 'English' },
          { value: 'zh-Hans', title: '简体中文' },
          { value: 'zh-Hant', title: '繁體中文' },
          { value: 'ja', title: '日本語' },
        ],
      },
    },
  },
  initialGlobals: { theme: 'light', locale: 'en' },
};

export default preview;
