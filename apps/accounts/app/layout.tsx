import type { ReactNode } from 'react';
import { ClientProviders } from './client-providers.tsx';
import { TranslationProvider } from '../i18n/client.ts';
import { getTranslation, requestLocale } from '../i18n/server.ts';
import './styles.css';

// Follow the system colour scheme before first paint; Rezics Aura keys dark
// mode on the `dark` class.
const themeScript = `(()=>{const q=matchMedia('(prefers-color-scheme: dark)');`
  + `const a=()=>document.documentElement.classList.toggle('dark',q.matches);a();`
  + `q.addEventListener('change',a)})()`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale();
  // Four small catalogs: seeding them all avoids a client load on every page.
  const { t, snapshot } = await getTranslation(['common', 'auth', 'consent', 'account'], [locale]);
  return <html lang={locale} suppressHydrationWarning><head><meta charSet="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>{t.common.productName}</title>
    <script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
    <body className="min-h-dvh bg-background"><TranslationProvider initial={snapshot} tags={[locale]}>
      <ClientProviders>{children}</ClientProviders></TranslationProvider></body></html>;
}
