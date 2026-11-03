import { AppearanceControls, AppearancePreferenceSync } from './appearance-controls';
import { TopBar, ShellTopActions } from './top-bar';
import { SideNavProvider, useSideNavCommunities } from './side-nav';
import { RezicsMark } from './mobile-mark';
import { PhoneNavigation, PhoneCreationProvider, PhoneUnreadDot, phoneTabClass } from './phone-navigation';
import { useOperation } from '../kernel/exposure';
import { cn } from '@rezics/ui/utils';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Toaster } from '@rezics/ui/shadcn/toast';
import { Menu } from '@rezics/ui/menu';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from '@rezics/ui/shadcn/sidebar';
import { Link, useLocation, useRouter, type AnyRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PageHeading } from './page-heading';
import { RouteState } from './route-state';
import { ShellSearch } from '../search/header-search/shell-search';
import { HeaderSearchFilterProvider } from '../search/header-search/filter-region';
import { UnreadBadge } from '../inbox/unread-badge';
import {
  Folders,
  Globe,
  Library,
  LogIn,
  LogOut,
  Menu as MenuIcon,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
} from 'lucide-react';
import type { SessionEnv } from '../session/client.ts';
import { NavigationEntries, NavigationLinks, NavigationProvider } from './navigation-view';
import type { NavigationContribution, NavigationSession } from './navigation';
import { FeatureSlotsProvider } from './feature-slots';
import type { SubjectPurchaseRegions } from '../features/pages/subject-slots';
import { useSession } from '../session/query';
import manropeFontUrl from '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url';
import { resolveAccountSecurity } from './account-menu-security';
import { PhoneNavigationClearance } from './phone-navigation-clearance';
type ShellSession = NavigationSession;

/** Hidden until the first Tab press; the sr-only utilities reveal it on focus. */
const skipLink = cn(
  'sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-9999 focus:rounded-xl focus:bg-primary',
  'focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground! focus:no-underline!',
  // The offset keeps the ring visible against the primary fill.
  'focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background focus:outline-none',
);
const messages = {
  shell_skip_to_content: m.shell_skip_to_content,
  shell_navigation: m.shell_navigation,
  shell_language: m.shell_language,
  shell_theme: m.shell_theme,
  shell_theme_system: m.shell_theme_system,
  shell_theme_light: m.shell_theme_light,
  shell_theme_dark: m.shell_theme_dark,
  nav_home: m.nav_home,
  nav_library: m.nav_library,
  nav_orders: m.nav_orders,
  nav_inbox: m.nav_inbox,
  nav_search: m.nav_search,
  shell_open_navigation: m.shell_open_navigation,
  shell_close_navigation: m.shell_close_navigation,
  shell_collapse_navigation: m.shell_collapse_navigation,
  shell_expand_navigation: m.shell_expand_navigation,
  not_found_heading: m.not_found_heading,
  not_found_message: m.not_found_message,
  error_heading: m.error_heading,
  error_message: m.error_message,
};
const headerControlClass =
  'h-9 rounded-full border border-border/60 focus-visible:border-primary focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const statusControlClass =
  'h-11 rounded-full px-4 focus-visible:border-primary focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const accountMenuLinkClass =
  'flex min-h-11 items-center gap-2.5 rounded-xl px-3 py-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground';
const readAuthIssuer = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  return (env as Partial<SessionEnv>).AUTH_ISSUER ?? '';
});

// False on the server and while the page hydrates, true afterwards. Controls that need script stay disabled until then.
const noSubscription = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

function Logo() {
  return (
    <Link to="/" aria-label="REZICS" className="flex h-10 shrink-0 items-center gap-2.5 rounded-xl px-1.5">
      <RezicsMark />
      <span className="hidden font-extrabold text-[15px] text-foreground tracking-[0.28em] sm:inline">REZICS</span>
    </Link>
  );
}
function Navigation({ pathname, session }: { pathname: string; session: ShellSession }) {
  const communities = useSideNavCommunities();
  return (
    <nav
      aria-label={m.shell_navigation()}
      className="fixed top-16 start-0 z-10 w-(--sidebar-width) group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
    >
      <SidebarContent className="max-h-[calc(100svh-4rem)] overflow-y-auto!">
        <SidebarGroup>
          <SidebarMenu>
            <NavigationEntries context={{ locale: getLocale(), pathname }} session={session} desktop>
              {(item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      className="h-10"
                      isActive={item.current}
                      aria-current={item.current ? 'page' : undefined}
                      aria-disabled={item.unavailable || undefined}
                      tooltip={item.unavailable ? `${item.label}: ${m.library_subject_unavailable()}` : item.label}
                      render={
                        item.unavailable ? (
                          <span role="link" />
                        ) : /[?#]/.test(item.path) ? (
                          <a href={item.href} />
                        ) : (
                          <Link<AnyRouter> to={item.path} />
                        )
                      }
                    >
                      {Icon && <Icon aria-hidden="true" className="text-sidebar-primary" />}
                      <span>{item.label}</span>
                      {item.unavailable && <span className="sr-only">{`: ${m.library_subject_unavailable()}`}</span>}
                      {item.id === 'shell.inbox' && <UnreadBadge />}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              }}
            </NavigationEntries>
          </SidebarMenu>
          <div className="group-data-[collapsible=icon]:[&_h2]:sr-only group-data-[collapsible=icon]:[&_[data-community-label]]:sr-only group-data-[collapsible=icon]:[&_[data-community-footer]]:hidden">
            {communities}
          </div>
        </SidebarGroup>
      </SidebarContent>
    </nav>
  );
}
function NavigationColumn({ pathname, session }: { pathname: string; session: ShellSession }) {
  const { isMobile } = useSidebar();
  if (isMobile) return null;
  return (
    <Sidebar collapsible="icon" className="static! top-auto! h-full! min-h-[calc(100svh-4rem)]!">
      <Navigation pathname={pathname} session={session} />
    </Sidebar>
  );
}
function ScriptFreeNavigation({ pathname, session }: { pathname: string; session: ShellSession }) {
  return (
    <noscript>
      <nav aria-label={m.shell_navigation()} className="border-b border-border/60 px-3 py-2 md:hidden">
        <ul className="flex flex-wrap gap-1">
          <NavigationEntries context={{ locale: getLocale(), pathname }} session={session} desktop>
            {(item) => {
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <a
                    href={item.href}
                    aria-current={item.current ? 'page' : undefined}
                    className="flex min-h-9 items-center gap-2 rounded-xl px-3 text-sm aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium"
                  >
                    {Icon && <Icon aria-hidden="true" className="size-4 text-sidebar-primary" />}
                    {item.label}
                  </a>
                </li>
              );
            }}
          </NavigationEntries>
        </ul>
      </nav>
      <style>{'[data-open-navigation]{display:none!important}'}</style>
    </noscript>
  );
}
export function NavigationToggle({
  collapsed,
  onToggle,
  pathname,
  session,
}: {
  collapsed: boolean;
  onToggle: () => void;
  pathname: string;
  session: ShellSession;
}) {
  const hydrated = useHydrated();
  const communities = useSideNavCommunities();
  const navigation = (
    <div className="grid gap-3">
      <NavigationLinks context={{ locale: getLocale(), pathname }} session={session} label={m.shell_navigation()} />
      {communities}
    </div>
  );
  return (
    <>
      <Menu
        title={m.shell_navigation()}
        closeOnNavigation
        content={navigation}
        trigger={
          <Button
            className={cn('relative md:hidden', headerControlClass)}
            variant="ghost"
            size="icon-lg"
            data-open-navigation
            disabled={!hydrated}
            aria-label={m.shell_open_navigation()}
          >
            <MenuIcon aria-hidden="true" />
            <PhoneUnreadDot session={session} />
          </Button>
        }
      />
      <Button
        className={cn('hidden md:inline-flex', headerControlClass)}
        variant="ghost"
        size="icon-lg"
        disabled={!hydrated}
        aria-label={collapsed ? m.shell_expand_navigation() : m.shell_collapse_navigation()}
        onClick={onToggle}
      >
        <MenuIcon aria-hidden="true" />
      </Button>
    </>
  );
}
// The account slot is reserved while the browser reads its private session.
export function AccountMenu({
  session,
  csrfToken,
  phone = false,
  readIssuer = readAuthIssuer,
}: {
  session: ShellSession;
  csrfToken: string | null;
  phone?: boolean;
  readIssuer?: () => Promise<string>;
}) {
  const location = useLocation();
  const { subject } = useSession();
  const lifecycle = useMemo(() => ({}), [session, subject, csrfToken, readIssuer]);
  const [security, setSecurity] = useState<{ lifecycle: object; href: string | null } | null>(null);
  // Hide the previous destination during the transition render, before effect cleanup runs.
  const securitySettingsHref = session === 'signed-in' && security?.lifecycle === lifecycle ? security.href : null;
  const canOpenLibrary = useOperation('library_entry.list');
  const canOpenCollections = useOperation('collection.list');
  const canOpenFollowing = useOperation('follow.list');
  useEffect(() => {
    if (session !== 'signed-in') return;
    return resolveAccountSecurity(readIssuer, (href) => setSecurity({ lifecycle, href }));
  }, [session, lifecycle, readIssuer]);
  const settings = (
    <div className="space-y-4 border-t border-border pt-4">
      {phone && <h2 className="text-base font-semibold">{m.settings_heading()}</h2>}
      <AppearanceControls />
      {phone && (
        <a href={`/${getLocale()}/settings`} className={accountMenuLinkClass}>
          <Settings aria-hidden="true" className="size-4" />
          {m.settings_heading()}
        </a>
      )}
    </div>
  );
  const trigger = phone ? (
    <button
      id="phone-account-menu-button"
      aria-controls="phone-account-menu"
      aria-label={m.shell_you()}
      aria-describedby="phone-account-state"
      type="button"
      className={phoneTabClass}
      aria-current={location.pathname.startsWith('/settings') ? 'page' : undefined}
    >
      <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-muted">
        <UserRound className="size-4" />
      </span>
      <span>{m.shell_you()}</span>
      <span id="phone-account-state" className="sr-only">
        {session === 'signed-in'
          ? m.shell_avatar_unavailable()
          : session === 'signed-out'
            ? m.account_sign_in()
            : m.shell_account_unavailable()}
      </span>
    </button>
  ) : undefined;
  if (session === 'unknown' || session === 'unavailable')
    return phone ? (
      <Menu
        title={m.shell_you()}
        trigger={trigger!}
        content={
          <div className="space-y-4">
            <p role="status">{m.shell_account_unavailable()}</p>
            {settings}
          </div>
        }
      />
    ) : null;
  if (session === 'signed-in') {
    const locale = getLocale();
    return (
      <Menu
        title={phone ? m.shell_you() : m.account_menu()}
        closeOnNavigation
        trigger={
          trigger ?? (
            <Button
              id="account-menu-button"
              className={cn(headerControlClass, 'w-full px-3 sm:px-4')}
              variant="ghost"
              size="lg"
              aria-label={m.account_menu()}
              aria-controls="account-menu"
            >
              <UserRound aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">{m.account_menu()}</span>
            </Button>
          )
        }
        content={
          <div
            id={phone ? 'phone-account-menu' : 'account-menu'}
            role="group"
            aria-labelledby={phone ? 'phone-account-menu-button' : 'account-menu-button'}
            className="grid gap-1"
          >
            {canOpenLibrary ? (
              <a href={`/${locale}/library`} className={accountMenuLinkClass}>
                <Library aria-hidden="true" className="size-4" />
                {m.library_nav_library()}
              </a>
            ) : null}
            {canOpenCollections ? (
              <a href={`/${locale}/library/collections`} className={accountMenuLinkClass}>
                <Folders aria-hidden="true" className="size-4" />
                {m.library_nav_collections()}
              </a>
            ) : null}
            {canOpenFollowing ? (
              <a href={`/${locale}/library/following`} className={accountMenuLinkClass}>
                <Users aria-hidden="true" className="size-4" />
                {m.library_nav_following()}
              </a>
            ) : null}
            <Link to="/realms" className={accountMenuLinkClass}>
              <Globe aria-hidden="true" className="size-4" />
              {m.realms_heading()}
            </Link>
            {!phone && (
              <a href={`/${locale}/settings`} className={accountMenuLinkClass}>
                <Settings aria-hidden="true" className="size-4" />
                {m.settings_heading()}
              </a>
            )}
            <a href={`/${locale}/accounts`} className={accountMenuLinkClass}>
              <Users aria-hidden="true" className="size-4" />
              {m.av_accounts()}
            </a>
            {securitySettingsHref ? (
              <a
                href={securitySettingsHref}
                data-account-security-settings
                // React's client autoFocus only focuses on mount, while this popover is still hidden.
                ref={(link) => {
                  link?.setAttribute('autofocus', '');
                }}
                className={accountMenuLinkClass}
              >
                <ShieldCheck aria-hidden="true" className="size-4" />
                {m.account_security_settings()}
              </a>
            ) : (
              <span
                role="link"
                aria-disabled="true"
                data-account-security-settings
                className={cn(accountMenuLinkClass, 'text-muted-foreground')}
              >
                <ShieldCheck aria-hidden="true" className="size-4" />
                {m.account_security_unavailable()}
              </span>
            )}
            <form method="post" action="/auth/sign-out" className="m-0">
              <input type="hidden" name="csrf_token" value={csrfToken ?? ''} />
              <Button type="submit" variant="ghost" size="lg" className="w-full justify-start rounded-xl px-3">
                <LogOut aria-hidden="true" />
                {m.account_sign_out()}
              </Button>
            </form>
            {settings}
          </div>
        }
      />
    );
  }
  const returnTo = location.publicHref.split('#')[0]!;
  return (
    <Menu
      title={phone ? m.shell_you() : m.account_menu()}
      trigger={
        trigger ?? (
          <Button
            className={cn(headerControlClass, 'w-full px-3 sm:px-4')}
            variant="ghost"
            size="lg"
            aria-label={m.account_menu()}
          >
            <LogIn aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">{m.account_menu()}</span>
          </Button>
        )
      }
      content={
        <div role="group" aria-label={m.account_menu()} className="grid gap-1">
          <a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} className={accountMenuLinkClass}>
            <LogIn aria-hidden="true" className="size-4" />
            {m.account_sign_in()}
          </a>
          {settings}
        </div>
      }
    />
  );
}
export type AppShellProps = {
  children: React.ReactNode;
  navigation?: readonly NavigationContribution[];
  subjectPurchase?: SubjectPurchaseRegions;
  search?: React.ReactNode;
  communities?: React.ReactNode;
  notifications?: React.ReactNode;
};
export function AppShell({ children, navigation, subjectPurchase, search, communities, notifications }: AppShellProps) {
  return (
    <NavigationProvider {...(navigation ? { contributions: navigation } : {})}>
      <FeatureSlotsProvider {...(subjectPurchase ? { subjectPurchase } : {})}>
        <Toaster>
          <AppearancePreferenceSync />
          <SideNavProvider communities={communities}>
            <ShellContent search={search} notifications={notifications}>
              {children}
            </ShellContent>
          </SideNavProvider>
        </Toaster>
      </FeatureSlotsProvider>
    </NavigationProvider>
  );
}
function ShellContent({
  children,
  search,
  notifications,
}: Pick<AppShellProps, 'children' | 'search' | 'notifications'>) {
  const { state: session, csrfToken } = useSession();
  const location = useLocation();
  const router = useRouter();
  const [railCollapsed, setRailCollapsed] = useState(false);
  useLayoutEffect(() => {
    setRailCollapsed(document.documentElement.dataset.nav === 'collapsed');
  }, []);
  useEffect(() => {
    let previous = router.state.location.href;
    const unsub = router.subscribe('onResolved', () => {
      const current = router.state.location.href;
      if (current !== previous) document.getElementById('main-content')?.focus();
      previous = current;
    });
    return unsub;
  }, [router]);
  const setCollapsed = (value: boolean) => {
    setRailCollapsed(value);
    if (value) document.documentElement.dataset.nav = 'collapsed';
    else delete document.documentElement.dataset.nav;
    document.cookie = `rezics_nav=${value ? 'collapsed' : 'expanded'}; Max-Age=31536000; Path=/; SameSite=Lax`;
  };
  return (
    <PhoneNavigationClearance>
      <PhoneCreationProvider>
        <HeaderSearchFilterProvider>
          <SidebarProvider
            className="flex-col"
            open={!railCollapsed}
            onOpenChange={(open) => {
              setCollapsed(!open);
              // The sidebar writes its own cookie after this call; the shell keeps one preference in rezics_nav.
              setTimeout(() => {
                document.cookie = 'sidebar_state=; Max-Age=0; Path=/';
              });
            }}
          >
            <a href="#main-content" className={skipLink}>
              {m.shell_skip_to_content()}
            </a>
            <link rel="preload" href={manropeFontUrl} as="font" type="font/woff2" crossOrigin="anonymous" />
            <TopBar
              navigation={
                <NavigationToggle
                  collapsed={railCollapsed}
                  onToggle={() => setCollapsed(!railCollapsed)}
                  pathname={location.pathname}
                  session={session}
                />
              }
              logo={<Logo />}
              search={search ?? <ShellSearch />}
              actions={
                <ShellTopActions
                  notifications={notifications}
                  session={session}
                  pathname={location.pathname}
                  returnTo={location.publicHref.split('#')[0]!}
                  account={<AccountMenu session={session} csrfToken={csrfToken} />}
                />
              }
            />
            <ScriptFreeNavigation pathname={location.pathname} session={session} />
            <div className="flex flex-1">
              <NavigationColumn pathname={location.pathname} session={session} />
              <SidebarInset
                id="main-content"
                tabIndex={-1}
                className="min-w-0 px-3 py-6 pb-[calc(6rem+env(safe-area-inset-bottom))] outline-none md:p-6"
              >
                <div className="mx-auto w-full max-w-5xl">{children}</div>
              </SidebarInset>
            </div>
            <PhoneNavigation
              session={session}
              csrfToken={csrfToken}
              pathname={location.pathname}
              account={<AccountMenu session={session} csrfToken={csrfToken} phone />}
            />
          </SidebarProvider>
        </HeaderSearchFilterProvider>
      </PhoneCreationProvider>
    </PhoneNavigationClearance>
  );
}
export function StatusPage({
  heading,
  message,
  onRetry,
  retrying = false,
}: {
  heading: string;
  message: string;
  onRetry?: (() => void) | undefined;
  retrying?: boolean | undefined;
}) {
  return <RouteState heading={heading} message={message} onRetry={onRetry} retrying={retrying} />;
}

export function HomePage() {
  return <PageHeading>{m.nav_home()}</PageHeading>;
}
export function NotFoundPage() {
  return <RouteState kind="missing" />;
}
export function ErrorPage({
  onRetry,
  retrying,
}: { onRetry?: (() => void) | undefined; retrying?: boolean | undefined } = {}) {
  return <StatusPage heading={m.error_heading()} message={m.error_message()} onRetry={onRetry} retrying={retrying} />;
}
