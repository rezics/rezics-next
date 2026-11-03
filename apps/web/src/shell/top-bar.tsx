import type { ReactNode } from 'react';
import { Bell, LogIn, Plus } from 'lucide-react';
import { Menu } from '@rezics/ui/menu';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { UnreadBadge, UnreadBadgeView } from '../inbox/unread-badge';
import type { UnreadCount } from '../inbox/inbox-read';
import { LanguageControl, ThemeControl } from './appearance-controls';
import { PhoneCreationLinks, useShellCreationActions } from './phone-navigation';
import { navigationPathMatches, type NavigationSession } from './navigation';

export function TopBar({
  navigation,
  logo,
  search,
  actions,
}: Record<'navigation' | 'logo' | 'search' | 'actions', ReactNode>) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/90 backdrop-blur-md has-[[data-expanded=true]]:z-50">
      <div className="flex min-h-16 items-center gap-2 px-3 lg:grid lg:grid-cols-[minmax(21rem,1fr)_minmax(0,40rem)_minmax(21rem,1fr)]">
        <div className="flex shrink-0 items-center gap-1">
          {navigation}
          {logo}
        </div>
        <div className="min-w-0 flex-1">{search}</div>
        <div className="ms-auto flex w-max shrink-0 items-center gap-1">{actions}</div>
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
  const signIn = `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
  return (
    <>
      <Menu
        title={m.shell_create()}
        closeOnNavigation
        trigger={
          <Button variant="ghost" size="icon-lg" className="rounded-full text-primary" aria-label={m.shell_create()}>
            <Plus aria-hidden="true" />
          </Button>
        }
        content={
          session === 'signed-out' ? (
            <a className="flex min-h-11 items-center gap-2 px-3 text-primary" href={signIn}>
              <LogIn aria-hidden="true" className="size-4" />
              {m.account_sign_in()}
            </a>
          ) : (
            <PhoneCreationLinks actions={actions} pathname={pathname} session={session} />
          )
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
          <div className="hidden md:block" data-session-slot>
            {account}
          </div>
        </>
      ) : session === 'signed-out' ? (
        <>
          <div className="hidden items-center gap-1 md:flex">
            <LanguageControl />
            <ThemeControl />
          </div>
          <a
            href={signIn}
            className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'rounded-full px-3 text-primary')}
          >
            <LogIn aria-hidden="true" className="size-4" />
            <span className="hidden sm:inline">{m.account_sign_in()}</span>
            <span className="sr-only sm:hidden">{m.account_sign_in()}</span>
          </a>
        </>
      ) : (
        <span className="sr-only" role="status">
          {m.shell_account_unavailable()}
        </span>
      )}
    </>
  );
}
