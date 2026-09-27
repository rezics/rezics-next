import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AccountMenu } from '../features/auth/account-menu.tsx';
import { serviceOrigin } from '../features/api/origins.ts';
import { readSession } from '../features/auth/session.ts';
import { SignInLink } from '../features/auth/sign-in-link.tsx';
import { AppShell } from '../features/shell/app-shell.tsx';
import { NotificationsLink } from '../features/shell/notifications-link.tsx';
import { NAV_COOKIE, parseNavCollapsed, parseTheme, THEME_COOKIE, themeClass } from '../features/shell/preferences.ts';
import { getMessages, requestLocale } from '../i18n/server.ts';
import './styles.css';

export const metadata: Metadata = {
  title: { default: 'REZICS', template: '%s · REZICS' },
  icons: { icon: { url: '/favicon.svg', type: 'image/svg+xml' } },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const locale = await requestLocale();
  const [messages, auth, session] = await Promise.all([getMessages('shell', locale),
    getMessages('auth', locale), readSession()]);
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  return <html lang={locale} className={themeClass(theme)}>
    <body className="min-h-dvh bg-background">
      <AppShell locale={locale} messages={messages} theme={theme} signedIn={Boolean(session)}
        navCollapsed={parseNavCollapsed(jar.get(NAV_COOKIE)?.value)}
        notifications={session ? <NotificationsLink /> : null}
        account={session ? <AccountMenu session={session} messages={auth}
          accountOrigin={serviceOrigin('ACCOUNT_ORIGIN')} /> : <SignInLink label={auth.signIn} />}>
        {children}
      </AppShell>
    </body>
  </html>;
}
