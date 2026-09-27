import type { Decorator, Preview } from '@storybook/react-vite';
import { useLayoutEffect } from 'react';
import { messages as shell } from '../features/shell/messages.ts';
import { ShellProvider } from '../features/shell/shell-provider.tsx';
import type { UiLocale } from '../i18n/define.ts';
import '../app/styles.css';
import { type StoryRoute, StoryRouteContext } from './next-navigation.ts';

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
        messages={shell[locale]}
        initialTheme={theme}
        initialCollapsed={Boolean(parameters.navCollapsed)}
      >
        <div className="aura-canvas min-h-dvh bg-background font-sans text-foreground">
          <Story />
        </div>
      </ShellProvider>
    </StoryRouteContext>
  );
};

const preview: Preview = {
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
        ],
      },
    },
  },
  initialGlobals: { theme: 'light', locale: 'en' },
};

export default preview;
