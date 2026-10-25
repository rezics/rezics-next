import type { Preview } from '@storybook/react-vite';
import { configure } from 'storybook/test';
import { setLocale } from '../src/paraglide/runtime.js';
import './preview.css';

configure({ asyncUtilTimeout: 15_000 });

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const preview: Preview = {
  globalTypes: {
    theme: { description: 'Color theme', toolbar: { title: 'Theme', icon: 'contrast', items: ['light', 'dark'] } },
    locale: { description: 'Locale', toolbar: { title: 'Locale', items: [...locales] } },
  },
  initialGlobals: { theme: 'light', locale: 'en' },
  parameters: { a11y: { test: 'error' } },
  decorators: [
    (Story, context) => {
      const locale = String(context.globals.locale ?? 'en') as (typeof locales)[number];
      setLocale(locale, { reload: false });
      document.documentElement.lang = locale;
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(context.globals.theme === 'dark' ? 'dark' : 'light');
      return <Story />;
    },
  ],
};
export default preview;
