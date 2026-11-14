import type { ReactNode } from 'react';
import { Bell, LogIn, Plus } from 'lucide-react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Skeleton } from '@rezics/ui/shadcn/skeleton';
import { cn } from '@rezics/ui/utils';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { UnreadBadge, UnreadBadgeView, type UnreadCount } from '../inbox';
import { LanguageControl, ThemeControl } from './appearance-controls';
import { ShellCreationMenu, shellSignInHref, useShellCreationActions } from './phone-navigation';
import { navigationPathMatches, type NavigationSession } from './navigation';

/** Search has its own compact row; labels and recovery can grow without taking its width. */
export function TopBar({
  navigation,
  logo,
  search,
  actions,
}: Record<'navigation' | 'logo' | 'search' | 'actions', ReactNode>) {
  return (
    <header
      data-shell-header
      className="sticky top-0 z-40 border-b border-border/60 bg-background/95 backdrop-blur-md has-[[data-expanded=true]]:z-50"
    >
      <div className="mx-auto grid w-full max-w-[112rem] grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 px-3 py-2 lg:min-h-16 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)] lg:gap-x-4">
        <div className="flex min-w-0 items-center gap-1">
          {navigation}
          {logo}
        </div>
        <div
          data-shell-header-search
          className="col-span-2 row-start-2 min-h-11 min-w-0 w-full lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:min-h-0 lg:mx-auto lg:max-w-160"
        >
          {search}
        </div>
        <div
          data-shell-header-actions
          className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-1 lg:col-start-3 lg:max-w-104"
        >
          {actions}
        </div>
      </div>
    </header>
  );
}

export function NotificationsLink({ pathname, badge }: { pathname: string; badge: ReactNode }) {
  const locale = getLocale();
  return (
    <a
      href={`/${locale}/inbox`}
      aria-current={navigationPathMatches({ locale, pathname }, '/inbox', 'prefix') ? 'page' : undefined}
      className={cn(buttonVariants({ variant: 'ghost', size: 'icon-lg' }), 'relative rounded-full text-primary')}
    >
      <Bell aria-hidden="true" className="size-5" />
      <span className="sr-only">{m.settings_notifications_heading()}</span>
      <span className="absolute -end-1 -top-1">{badge}</span>
    </a>
  );
}

/** A failed session stays visible at every width, alongside its real recovery anchor. */
export function UnavailableAccountAction({ signIn }: { signIn: string }) {
  return (
    <div data-account-unavailable className="flex min-w-0 flex-1 items-center justify-end gap-2">
      <span role="status" className="min-w-0 max-w-44 text-xs leading-snug wrap-anywhere text-muted-foreground">
        {m.shell_account_unavailable()}
      </span>
      <a
        href={signIn}
        aria-label={m.account_sign_in()}
        title={m.account_sign_in()}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'lg' }),
          'min-h-11 min-w-11 shrink-0 rounded-full px-3 text-primary',
        )}
      >
        <LogIn aria-hidden="true" className="size-4 shrink-0" />
        <span className="hidden sm:inline">{m.account_sign_in()}</span>
      </a>
    </div>
  );
}

export function ShellTopActions({
  session,
  pathname,
  returnTo,
  account,
  unread,
  notifications,
}: {
  session: NavigationSession;
  pathname: string;
  returnTo: string;
  account: ReactNode;
  unread?: UnreadCount;
  notifications?: ReactNode;
}) {
  const actions = useShellCreationActions(session);
  const signIn = shellSignInHref(pathname, returnTo);
  return (
    <>
      <ShellCreationMenu
        actions={actions}
        pathname={pathname}
        session={session}
        returnTo={returnTo}
        trigger={
          <Button
            size="lg"
            className="min-h-11 h-auto min-w-11 shrink-0 rounded-full px-3 py-2"
            aria-label={m.shell_create()}
          >
            <Plus aria-hidden="true" />
            <span className="hidden max-w-32 wrap-anywhere whitespace-normal xl:inline">{m.shell_create()}</span>
          </Button>
        }
      />
      {session === 'signed-in' ? (
        <>
          {notifications ?? (
            <NotificationsLink
              pathname={pathname}
              badge={unread ? <UnreadBadgeView data={unread} /> : <UnreadBadge />}
            />
          )}
          <div
            className="hidden md:block [@media(display-mode:standalone)]:block [[data-standalone]_&]:block"
            data-session-slot
          >
            {account}
          </div>
        </>
      ) : session === 'signed-out' ? (
        <>
          <div className="hidden min-w-0 flex-wrap items-center justify-end gap-1 md:flex [@media(display-mode:standalone)]:flex [[data-standalone]_&]:flex">
            <LanguageControl />
            <ThemeControl />
          </div>
          <a
            href={signIn}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'lg' }),
              'min-h-11 h-auto min-w-11 max-w-48 rounded-full px-3 py-2 text-primary',
            )}
          >
            <LogIn aria-hidden="true" className="size-4" />
            <span className="min-w-0 wrap-anywhere whitespace-normal">{m.account_sign_in()}</span>
          </a>
        </>
      ) : session === 'unknown' ? (
        <div data-session-pending role="status" aria-busy="true" className="flex items-center gap-1">
          <span className="sr-only">{m.candidate_loading()}</span>
          <Skeleton aria-hidden className="size-11 rounded-full motion-reduce:animate-none" />
          <Skeleton aria-hidden className="hidden size-11 rounded-full motion-reduce:animate-none md:block" />
        </div>
      ) : (
        <UnavailableAccountAction signIn={signIn} />
      )}
    </>
  );
}
