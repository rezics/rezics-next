import type { Preview } from '@storybook/react-vite';
import { useEffect, type ReactNode } from 'react';
import { configure } from 'storybook/test';
import { setLocale } from '../src/paraglide/runtime.js';
import './preview.css';

configure({ asyncUtilTimeout: 15_000 });

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;

function HydrationMarker({ storyId, children }: { storyId: string; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.hydrated = '';
    return () => {
      delete document.documentElement.dataset.hydrated;
    };
  }, [storyId]);

  return children;
}

const preview: Preview = {
  globalTypes: {
    theme: { description: 'Color theme', toolbar: { title: 'Theme', icon: 'contrast', items: ['light', 'dark'] } },
    locale: { description: 'Locale', toolbar: { title: 'Locale', items: [...locales] } },
  },
  initialGlobals: { theme: 'light', locale: 'en' },
  parameters: { a11y: { test: 'error' } },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
      const locale = String(context.globals.locale ?? 'en');
      setLocale(locale as (typeof locales)[number], { reload: false });
      document.documentElement.lang = locale;
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
      document.cookie = `rezics_theme=${theme}; Path=/; SameSite=Lax`;
      return (
        <HydrationMarker key={context.id} storyId={context.id}>
          <Story />
        </HydrationMarker>
      );
    },
  ],
};
export default preview;
