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
      const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
      const locale = String(context.globals.locale ?? 'en');
      setLocale(locale as (typeof locales)[number], { reload: false });
      document.documentElement.lang = locale;
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
      return <Story />;
    },
  ],
};
export default preview;
