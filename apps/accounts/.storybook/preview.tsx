import type { Decorator, Preview } from '@storybook/react-vite';
import { Suspense, useLayoutEffect } from 'react';
import { type FakeAccount, fakeAccountClient } from './account-client.ts';
import { AccountClientProvider } from '../features/api/account-client.tsx';
import { TranslationProvider } from '../i18n/client.ts';
import { i18n } from '../i18n/locale.ts';
import '../app/styles.css';

// Theme, language and phone are story globals, so every page state can be
// rendered and tested light and dark, en and zh-CN, desktop and phone.
const withAccountsApp: Decorator = (Story, context) => {
  const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
  const locale = context.globals.locale === 'zh-CN' ? 'zh-CN' : 'en';
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.lang = locale;
  }, [theme, locale]);
  const account = context.parameters.account as FakeAccount | undefined;
  const { snapshot } = context.loaded.i18n as Awaited<ReturnType<typeof seed>>;
  return <TranslationProvider key={locale} initial={snapshot} tags={[locale]}>
    <AccountClientProvider value={fakeAccountClient(account)}>
      <Suspense fallback={null}><Story /></Suspense>
    </AccountClientProvider>
  </TranslationProvider>;
};

// Like the root layout, seed every catalog so no story suspends mid-interaction.
const seed = (locale: string) => i18n.getTranslation(['common', 'auth', 'consent', 'account', 'admin'], [locale]);

const preview: Preview = {
  loaders: [async ({ globals }) => ({ i18n: await seed(globals.locale === 'zh-CN' ? 'zh-CN' : 'en') })],
  decorators: [withAccountsApp],
  parameters: {
    layout: 'fullscreen',
    a11y: { test: 'error' },
    viewport: { options: {
      desktop: { name: 'Desktop 1280×860', styles: { width: '1280px', height: '860px' }, type: 'desktop' },
      phone: { name: 'Phone 390×844', styles: { width: '390px', height: '844px' }, type: 'mobile' },
    } },
  },
  globalTypes: {
    theme: { description: 'Colour scheme', toolbar: { icon: 'mirror', dynamicTitle: true,
      items: [{ value: 'light', title: 'Light' }, { value: 'dark', title: 'Dark' }] } },
    locale: { description: 'Interface language', toolbar: { icon: 'globe', dynamicTitle: true,
      items: [{ value: 'en', title: 'English' }, { value: 'zh-CN', title: '简体中文' }] } },
  },
  initialGlobals: { theme: 'light', locale: 'en', viewport: { value: 'desktop', isRotated: false } },
};

export default preview;
