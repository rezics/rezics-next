import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AccountMenu } from '../features/shell/account-menu.tsx';
import { AppShell } from '../features/shell/app-shell.tsx';
import { NotificationsLink } from '../features/shell/notifications-link.tsx';
import { NAV_COOKIE, parseNavCollapsed, parseTheme, THEME_COOKIE, themeClass } from '../features/shell/preferences.ts';
import type { ShellSession } from '../features/shell/session.ts';
import { getMessages, requestLocale } from '../i18n/server.ts';
import './styles.css';

export const metadata: Metadata = {
  title: { default: 'REZICS', template: '%s · REZICS' },
  icons: { icon: { url: '/favicon.svg', type: 'image/svg+xml' } },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

type CookieJar = Awaited<ReturnType<typeof cookies>>;

// Until the session layer offers a session read, the shell knows only that an
// access token and an acting subject exist.
function cookieSession(jar: CookieJar): ShellSession | null {
  if (!jar.get('rezics_access')?.value) return null;
  const subject = jar.get('rezics_subject')?.value;
  const id = subject?.split('/').at(-1);
  return subject && id ? { agent: { id: subject, label: id.slice(0, 8) } } : {};
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const locale = await requestLocale();
  const messages = await getMessages('shell', locale);
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  const session = cookieSession(jar);
  return <html lang={locale} className={themeClass(theme)}>
    <body className="aura-canvas min-h-dvh">
      <AppShell locale={locale} messages={messages} theme={theme}
        navCollapsed={parseNavCollapsed(jar.get(NAV_COOKIE)?.value)}
        notifications={session ? <NotificationsLink /> : null}
        account={<AccountMenu session={session} />}>
        {children}
      </AppShell>
    </body>
  </html>;
}
