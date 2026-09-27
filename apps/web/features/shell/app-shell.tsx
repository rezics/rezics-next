import { SkipNavLink } from '@rezics/ui/skip-nav';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { BottomNav } from './bottom-nav.tsx';
import { Logo } from './logo.tsx';
import type { ShellMessages } from './messages.ts';
import { NavCollapseToggle, NavDrawer, SIDE_NAVIGATION_ID } from './nav-controls.tsx';
import type { Theme } from './preferences.ts';
import { SearchField } from './search-field.tsx';
import { ShellProvider } from './shell-provider.tsx';
import { SideNav } from './side-nav.tsx';

export const MAIN_CONTENT_ID = 'main-content';

export interface AppShellProps {
  locale: UiLocale;
  messages: ShellMessages;
  theme: Theme;
  navCollapsed: boolean;
  /** The account slot, normally <AccountMenu session={…} />. */
  account: ReactNode;
  /** The notifications slot; omitted while signed out. */
  notifications?: ReactNode;
  children: ReactNode;
}

/**
 * The frame every route renders in. Desktop: top bar over a collapsible side
 * navigation. Phones: a compact top bar, a bottom navigation and the side
 * navigation in a drawer. Routes render their content, not a second <main>.
 */
export function AppShell({ locale, messages, theme, navCollapsed, account, notifications, children }: AppShellProps) {
  return <ShellProvider locale={locale} messages={messages} initialTheme={theme} initialCollapsed={navCollapsed}>
    <SkipNavLink id={MAIN_CONTENT_ID}>{messages.skipToContent}</SkipNavLink>
    <header className="sticky top-0 z-40 border-border/60 border-b bg-background/85 backdrop-blur-md">
      <div className="flex h-16 items-center gap-2 px-2 sm:gap-3 sm:px-4">
        <div className="flex shrink-0 items-center gap-1 md:w-56 md:group-data-[nav=collapsed]/shell:w-auto">
          <NavDrawer />
          <NavCollapseToggle />
          <Logo label={messages.home} />
        </div>
        <div className="min-w-0 flex-1 md:max-w-2xl"><SearchField /></div>
        <div className="ms-auto flex shrink-0 items-center gap-1 sm:gap-2">{notifications}{account}</div>
      </div>
    </header>
    <div className="flex">
      <aside id={SIDE_NAVIGATION_ID} className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-64 shrink-0
        border-border/60 border-e bg-sidebar/60 md:block md:group-data-[nav=collapsed]/shell:w-18">
        <SideNav variant="rail" />
      </aside>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="min-w-0 flex-1 outline-none
        pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">{children}</main>
    </div>
    <BottomNav />
  </ShellProvider>;
}
