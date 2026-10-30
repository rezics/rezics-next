import type { Preview } from '@storybook/react-vite';
import { LocaleProvider } from '../src/components/locale.tsx';
import { configure } from 'storybook/test';
import './preview.css';

// Gates run several at once, and fifteen seconds stays inside the stories' 30-second test timeout.
configure({ asyncUtilTimeout: 15_000 });

const preview: Preview = {
  globalTypes: {
    theme: { description: 'Color theme', toolbar: { title: 'Theme', icon: 'contrast', items: ['light', 'dark'] } },
    locale: {
      description: 'Locale',
      toolbar: { title: 'Locale', items: ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] },
    },
  },
  initialGlobals: { theme: 'light', locale: 'en' },
  parameters: {
    a11y: { test: 'error' },
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '860px' } },
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
      const locale = String(context.globals.locale ?? 'en');
      document.documentElement.lang = locale;
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
      return (
        <LocaleProvider locale={locale}>
          <Story />
        </LocaleProvider>
      );
    },
  ],
};

export default preview;
