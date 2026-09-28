import interfaceFont from '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url';
import { SkipNavLink } from '@rezics/ui/skip-nav';
import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import type { UiLocale } from '../../i18n/define.ts';
import { BottomNav } from './bottom-nav.tsx';
import { Logo } from './logo.tsx';
import { LocaleSelect } from './locale-switch.tsx';
import type { ShellMessages } from './messages.ts';
import { NavCollapseToggle, NavDrawer, SIDE_NAVIGATION_ID } from './nav-controls.tsx';
import type { Theme } from './preferences.ts';
import { SearchField } from './search-field.tsx';
import { ShellProvider } from './shell-provider.tsx';
import { SideNav } from './side-nav.tsx';
import { ThemeNotice } from './theme-notice.tsx';
import { ThemeMenu } from './theme-switch.tsx';

export const MAIN_CONTENT_ID = 'main-content';

export interface AppShellProps {
  locale: UiLocale;
  messages: ShellMessages;
  theme: Theme;
  navCollapsed: boolean;
  signedIn?: boolean;
  /** The account slot, normally <AccountMenu session={…} />. */
  account: ReactNode;
  /** The notifications slot; omitted while signed out. */
  notifications?: ReactNode;
  /** Followed and official communities below the main items, normally <ShellCommunities />. */
  communities?: ReactNode;
  children: ReactNode;
}

/**
 * The frame every route renders in. Desktop: top bar over a collapsible side
 * navigation. Phones: a compact top bar, a bottom navigation and the side
 * navigation in a drawer. Routes render their content, not a second <main>.
 */
export function AppShell({ locale, messages, theme, navCollapsed, signedIn, account, notifications, communities,
  children }: AppShellProps) {
  // The interface face, requested with the stylesheet rather than after it: arriving a round trip later on a
  // phone, the swap re-wrapped the text above the fold and shifted the page (CLS 0.15 on Home).
  preload(interfaceFont, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  return <ShellProvider locale={locale} messages={messages} initialTheme={theme} initialCollapsed={navCollapsed}
    signedIn={signedIn}>
    <SkipNavLink id={MAIN_CONTENT_ID}>{messages.skipToContent}</SkipNavLink>
    {/* The reader hides the header and tab bar on phones while its reader scrolls down (html[data-reading]). */}
    <header className="sticky top-0 z-40 border-border/60 border-b bg-background/85 backdrop-blur-md
      transition-transform duration-300 motion-reduce:transition-none max-md:[html[data-reading=hidden]_&]:-translate-y-full">
      <div className="flex min-h-16 flex-wrap items-center gap-2 px-2 py-2 sm:h-16 sm:flex-nowrap sm:gap-3 sm:px-4 sm:py-0">
        <div className="flex shrink-0 items-center gap-1 md:w-56 md:group-data-[nav=collapsed]/shell:w-auto">
          <NavDrawer communities={communities} />
          <NavCollapseToggle />
          <Logo label={messages.home} locale={locale} />
        </div>
        <div className="order-3 w-full sm:order-none sm:min-w-0 sm:flex-1 md:max-w-2xl"><SearchField /></div>
        <div className="ms-auto flex shrink-0 items-center gap-1 sm:gap-2">
          {notifications}
          {signedIn ? null : <><LocaleSelect locale={locale} label={messages.language} /><ThemeMenu /></>}
          {account}
        </div>
      </div>
    </header>
    <div className="flex">
      <aside id={SIDE_NAVIGATION_ID} className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-64 shrink-0
        border-border/60 border-e bg-sidebar/90 md:block md:group-data-[nav=collapsed]/shell:w-18">
        <SideNav variant="rail" communities={communities} />
      </aside>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="min-w-0 flex-1 outline-none
        pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">{children}</main>
    </div>
    <BottomNav />
    <ThemeNotice />
  </ShellProvider>;
}
