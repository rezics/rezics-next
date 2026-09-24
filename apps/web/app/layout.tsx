import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { SiteHeader } from '../features/shell/site-header.tsx';
import { getTranslation, requestLocale } from '../i18n/server.ts';
import './styles.css';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const authenticated = Boolean((await cookies()).get('rezics_access')?.value);
  const locale = await requestLocale();
  const { data: messages } = await getTranslation('shell', [locale]);
  return <html lang={locale}><head><meta charSet="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>REZICS</title></head><body><SiteHeader authenticated={authenticated} locale={locale}
      messages={messages} />{children}</body></html>;
}
