import { useOperation } from '../kernel/exposure';
import { cn } from '@rezics/ui/utils';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@rezics/ui/shadcn/dialog';
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
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getLocale, locales, setLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { PageHeading } from './page-heading';
import { ShellSearch } from '../search/search.tsx';
import { UnreadBadge } from '../inbox/unread-badge';
import {
  Folders,
  Globe,
  House,
  Inbox as InboxIcon,
  Library,
  LogIn,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  UserRound,
  Users,
} from 'lucide-react';
import type { SessionEnv } from '../session/client.ts';
import type { SessionState } from '../session/state.ts';
import { useSession } from '../session/query';
type ShellSession = SessionState | 'unknown';

const names = {
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
} as const;
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
  nav_inbox: m.nav_inbox,
  nav_search: m.nav_search,
  shell_open_navigation: m.shell_open_navigation,
  shell_close_navigation: m.shell_close_navigation,
  shell_collapse_navigation: m.shell_collapse_navigation,
  shell_expand_navigation: m.shell_expand_navigation,
  home_heading: m.home_heading,
  not_found_heading: m.not_found_heading,
  not_found_message: m.not_found_message,
  error_heading: m.error_heading,
  error_message: m.error_message,
};
const destinations = [
  { to: '/', message: messages.nav_home, icon: House, phone: true },
  { to: '/search', message: messages.nav_search, icon: Search, phone: true },
  { to: '/library', message: messages.nav_library, icon: Library, phone: true, signedIn: true },
] as const;

function destinationCurrent(pathname: string, to: (typeof destinations)[number]['to']): boolean {
  if (to === '/library') return pathname === '/library' || pathname.startsWith('/library/');
  return pathname === to;
}

function useOfferedDestinations(session: ShellSession) {
  const admitted = useOperation('library_entry.list');
  return destinations.filter((item) => !('signedIn' in item) || (session === 'signed-in' && admitted));
}
const headerControlClass =
  'h-9 rounded-full border border-border/60 focus-visible:border-primary focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const statusControlClass =
  'h-9 rounded-full px-4 focus-visible:border-primary focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const accountMenuLinkClass =
  'flex min-h-9 items-center gap-2.5 rounded-xl px-3 py-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground';
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

function Mark() {
  return (
    <svg aria-hidden="true" viewBox="0 142.857 1000 714.286" className="h-5 w-7 shrink-0 fill-brand">
      <path d="M0 571.429 642.857 142.857 571.429 428.571 1000 142.857v285.714L357.143 857.143l71.428-285.714L0 857.143Z" />
    </svg>
  );
}
function Logo() {
  return (
    <Link to="/" aria-label="REZICS" className="flex h-10 shrink-0 items-center gap-2.5 rounded-xl px-1.5">
      <Mark />
      <span className="hidden font-extrabold text-[15px] text-foreground tracking-[0.28em] sm:inline">REZICS</span>
    </Link>
  );
}
function Navigation({ pathname, session }: { pathname: string; session: ShellSession }) {
  const offered = useOfferedDestinations(session);
  return (
    <nav
      aria-label={m.shell_navigation()}
      className="fixed top-16 start-0 z-10 w-(--sidebar-width) group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
    >
      <SidebarContent className="overflow-visible!">
        <SidebarGroup>
          <SidebarMenu>
            {offered.map((item) => {
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    className="h-10"
                    isActive={destinationCurrent(pathname, item.to)}
                    tooltip={item.message()}
                    render={<Link to={item.to} />}
                  >
                    <Icon aria-hidden="true" className="text-sidebar-primary" />
                    <span>{item.message()}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
            {session === 'signed-in' ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="h-10"
                  isActive={pathname === '/inbox'}
                  tooltip={messages.nav_inbox()}
                  render={<Link to="/inbox" />}
                >
                  <InboxIcon aria-hidden="true" className="text-sidebar-primary" />
                  <span>{messages.nav_inbox()}</span>
                  <UnreadBadge />
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
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
  const offered = useOfferedDestinations(session);
  return (
    <noscript>
      <nav aria-label={m.shell_navigation()} className="border-b border-border/60 px-3 py-2 md:hidden">
        <ul className="flex flex-wrap gap-1">
          {offered.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={destinationCurrent(pathname, item.to) ? 'page' : undefined}
                  className="flex min-h-9 items-center gap-2 rounded-xl px-3 text-sm aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium"
                >
                  <Icon aria-hidden="true" className="size-4 text-sidebar-primary" />
                  {item.message()}
                </Link>
              </li>
            );
          })}
          {session === 'signed-in' ? (
            <li>
              <Link
                to="/inbox"
                aria-current={pathname === '/inbox' ? 'page' : undefined}
                className="flex min-h-9 items-center gap-2 rounded-xl px-3 text-sm aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium"
              >
                <InboxIcon aria-hidden="true" className="size-4 text-sidebar-primary" />
                {messages.nav_inbox()}
              </Link>
            </li>
          ) : null}
        </ul>
      </nav>
      <style>{'[data-open-navigation]{display:none!important}'}</style>
    </noscript>
  );
}
function NavigationToggle({
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
  const offered = useOfferedDestinations(session);
  const locale = getLocale();
  const navigation = (
    <nav aria-label={m.shell_navigation()} className="grid gap-1">
      {offered.map((item) => {
        const Icon = item.icon;
        return (
          <a
            key={item.to}
            href={`/${locale}${item.to === '/' ? '' : item.to}`}
            aria-current={destinationCurrent(pathname, item.to) ? 'page' : undefined}
            className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium"
          >
            <Icon aria-hidden="true" className="size-4 text-sidebar-primary" />
            {item.message()}
          </a>
        );
      })}
    </nav>
  );
  return (
    <>
      <Menu
        title={m.shell_navigation()}
        content={navigation}
        trigger={
          <Button
            className={cn('md:hidden', headerControlClass)}
            variant="ghost"
            size="icon-lg"
            data-open-navigation
            disabled={!hydrated}
            aria-label={m.shell_open_navigation()}
          >
            <MenuIcon aria-hidden="true" />
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
function ThemeControl() {
  const hydrated = useHydrated();
  const [theme, setTheme] = useState<'system' | 'light' | 'dark' | null>(null);
  useLayoutEffect(() => {
    const cookie = /(?:^|;\s*)rezics_theme=(system|light|dark)(?:;|$)/.exec(document.cookie)?.[1];
    setTheme(cookie === 'light' || cookie === 'dark' ? cookie : 'system');
  }, []);
  useLayoutEffect(() => {
    if (theme === null) return;
    const preference = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && preference.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.classList.toggle('light', !dark);
    };
    apply();
    if (theme !== 'system') return;
    preference.addEventListener('change', apply);
    return () => preference.removeEventListener('change', apply);
  }, [theme]);
  const icons = { system: Monitor, light: Sun, dark: Moon };
  const Icon = icons[theme ?? 'system'];
  const choose = (value: string) => {
    const next = value as Exclude<typeof theme, null>;
    setTheme(next);
    document.documentElement.classList.remove('light', 'dark');
    if (next !== 'system') document.documentElement.classList.add(next);
    document.cookie = `rezics_theme=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
  };
  return (
    <Menu
      title={m.shell_theme()}
      entries={[
        {
          type: 'radio',
          label: m.shell_theme(),
          value: theme ?? 'system',
          options: [
            { value: 'system', label: m.shell_theme_system() },
            { value: 'light', label: m.shell_theme_light() },
            { value: 'dark', label: m.shell_theme_dark() },
          ],
          onValueChange: choose,
        },
      ]}
      trigger={
        <Button
          className={headerControlClass}
          variant="ghost"
          size="icon-lg"
          disabled={!hydrated}
          aria-label={m.shell_theme()}
          title={m.shell_theme()}
        >
          <Icon aria-hidden="true" className="size-5" />
        </Button>
      }
    />
  );
}
function LanguageControl() {
  const hydrated = useHydrated();
  const locale = getLocale();
  const change = async (value: string | null) => {
    if (!value || value === locale) return;
    const next = value as typeof locale;
    document.cookie = `rezics_locale=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
    await setLocale(next);
  };
  return (
    <>
      <div data-language-js className="contents">
        <Menu
          title={m.shell_language()}
          entries={[
            {
              type: 'radio',
              label: m.shell_language(),
              value: locale,
              options: locales.map((option) => ({ value: option, label: names[option] })),
              onValueChange: change,
            },
          ]}
          trigger={
            <Button
              className={cn(
                headerControlClass,
                'max-w-32 bg-transparent px-3 hover:bg-accent/60 max-md:w-9 max-md:justify-center max-md:px-0',
              )}
              variant="ghost"
              size="lg"
              disabled={!hydrated}
            >
              <Globe aria-hidden="true" />
              <span className="sr-only">{m.shell_language()} </span>
              <span className="hidden md:inline">{names[locale]}</span>
            </Button>
          }
        />
      </div>
      <noscript>
        <details>
          <summary className="cursor-pointer rounded-lg border border-border/60 px-2 py-2">{names[locale]}</summary>
          <div className="absolute z-50 grid rounded-xl bg-popover p-2">
            {locales.map((value) => (
              <a key={value} lang={value} href={`/${value}`} className="px-2 py-1">
                {names[value]}
              </a>
            ))}
          </div>
        </details>
        <style>{'[data-language-js]{display:none!important}'}</style>
      </noscript>
    </>
  );
}
// The account slot is reserved while the browser reads its private session.
function SessionControl({ session, csrfToken }: { session: ShellSession; csrfToken: string | null }) {
  const location = useLocation();
  const [securitySettingsHref, setSecuritySettingsHref] = useState('/security');
  const canOpenLibrary = useOperation('library_entry.list');
  const canOpenCollections = useOperation('collection.list');
  const canOpenFollowing = useOperation('follow.list');
  useEffect(() => {
    if (session !== 'signed-in') return;
    let active = true;
    void readAuthIssuer().then((issuer) => {
      if (active && issuer) setSecuritySettingsHref(new URL('/security', issuer).href);
    });
    return () => {
      active = false;
    };
  }, [session]);
  if (session === 'unknown' || session === 'unavailable') return null;
  if (session === 'signed-in') {
    const locale = getLocale();
    return (
      <Menu
        title={m.account_menu()}
        trigger={
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
        }
        content={
          <div id="account-menu" role="group" aria-labelledby="account-menu-button" className="grid gap-1">
            {canOpenLibrary ? (
              <a href={`/${locale}/library`} className={accountMenuLinkClass}>
                <Library aria-hidden="true" className="size-4" />
                {m.library_nav_library()}
              </a>
            ) : null}
            {canOpenCollections ? (
              <a href={`/${locale}/collections`} className={accountMenuLinkClass}>
                <Folders aria-hidden="true" className="size-4" />
                {m.library_nav_collections()}
              </a>
            ) : null}
            {canOpenFollowing ? (
              <a href={`/${locale}/following`} className={accountMenuLinkClass}>
                <Users aria-hidden="true" className="size-4" />
                {m.library_nav_following()}
              </a>
            ) : null}
            <a href={`/${locale}/settings`} className={accountMenuLinkClass}>
              <Settings aria-hidden="true" className="size-4" />
              {m.settings_heading()}
            </a>
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
            <form method="post" action="/auth/sign-out" className="m-0">
              <input type="hidden" name="csrf_token" value={csrfToken ?? ''} />
              <Button type="submit" variant="ghost" size="lg" className="w-full justify-start rounded-xl px-3">
                <LogOut aria-hidden="true" />
                {m.account_sign_out()}
              </Button>
            </form>
          </div>
        }
      />
    );
  }
  const returnTo = location.publicHref.split('#')[0]!;
  return (
    <Menu
      title={m.account_menu()}
      trigger={
        <Button
          className={cn(headerControlClass, 'w-full px-3 sm:px-4')}
          variant="ghost"
          size="lg"
          aria-label={m.account_menu()}
        >
          <LogIn aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">{m.account_menu()}</span>
        </Button>
      }
      content={
        <div role="group" aria-label={m.account_menu()} className="grid gap-1">
          <a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} className={accountMenuLinkClass}>
            <LogIn aria-hidden="true" className="size-4" />
            {m.account_sign_in()}
          </a>
        </div>
      }
    />
  );
}
export function AppShell({ children }: { children: React.ReactNode }) {
  const { state: session, csrfToken } = useSession();
  const location = useLocation();
  const router = useRouter();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [phoneSearchOpen, setPhoneSearchOpen] = useState(false);
  useLayoutEffect(() => {
    setRailCollapsed(document.documentElement.dataset.nav === 'collapsed');
  }, []);
  useEffect(() => {
    const unsub = router.subscribe('onResolved', () => document.getElementById('main-content')?.focus());
    return unsub;
  }, [router]);
  const setCollapsed = (value: boolean) => {
    setRailCollapsed(value);
    if (value) document.documentElement.dataset.nav = 'collapsed';
    else delete document.documentElement.dataset.nav;
    document.cookie = `rezics_nav=${value ? 'collapsed' : 'expanded'}; Max-Age=31536000; Path=/; SameSite=Lax`;
  };
  return (
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
      <link
        rel="preload"
        href="/node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
      />
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/90 backdrop-blur">
        <div className="flex h-16 items-center gap-2 px-3">
          <NavigationToggle
            collapsed={railCollapsed}
            onToggle={() => setCollapsed(!railCollapsed)}
            pathname={location.pathname}
            session={session}
          />
          <Logo />
          <div className="pointer-events-none absolute inset-x-0 mx-auto hidden w-full max-w-[40rem] px-40 md:block">
            <div className="pointer-events-auto">
              <ShellSearch />
            </div>
          </div>
          <div className="ms-auto flex items-center gap-2">
            <Dialog open={phoneSearchOpen} onOpenChange={setPhoneSearchOpen}>
              <DialogTrigger
                render={
                  <Button
                    className={cn('md:hidden', headerControlClass)}
                    variant="ghost"
                    size="icon-lg"
                    aria-label={m.search_label()}
                  />
                }
              >
                <Search aria-hidden="true" />
              </DialogTrigger>
              <DialogContent className="inset-0 h-svh w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 p-4 md:hidden">
                <DialogTitle className="sr-only">{m.search_label()}</DialogTitle>
                <ShellSearch />
              </DialogContent>
            </Dialog>
            <LanguageControl />
            <ThemeControl />
            <div data-session-slot className="relative flex h-9 w-10 shrink-0 items-center justify-center sm:w-36">
              <SessionControl session={session} csrfToken={csrfToken} />
              <noscript>
                <a
                  href={`/${getLocale()}/settings`}
                  className={cn(
                    headerControlClass,
                    'inline-flex h-9 w-full items-center justify-center gap-2 px-3 text-sm sm:px-4',
                  )}
                >
                  <UserRound aria-hidden="true" className="size-4" />
                  <span className="sr-only sm:not-sr-only">{m.account_menu()}</span>
                </a>
              </noscript>
            </div>
          </div>
        </div>
      </header>
      <ScriptFreeNavigation pathname={location.pathname} session={session} />
      <div className="flex flex-1">
        <NavigationColumn pathname={location.pathname} session={session} />
        <SidebarInset id="main-content" tabIndex={-1} className="min-w-0 p-6 outline-none">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
export function StatusPage({ heading, message }: { heading: string; message: string }) {
  const locale = getLocale();
  return (
    <div className="max-w-prose space-y-4">
      <PageHeading>{heading}</PageHeading>
      <p className="leading-7">{message}</p>
      <div className="flex flex-wrap items-center gap-2">
        <a data-slot="button" className={cn(buttonVariants({ size: 'lg' }), statusControlClass)} href={`/${locale}`}>
          {m.status_home()}
        </a>
        <a
          data-slot="button"
          className={cn(buttonVariants({ size: 'lg', variant: 'outline' }), statusControlClass)}
          href={`/${locale}/search`}
        >
          {m.status_search()}
        </a>
      </div>
    </div>
  );
}
export function HomePage() {
  return <PageHeading>{m.home_heading()}</PageHeading>;
}
export function NotFoundPage() {
  return <StatusPage heading={m.not_found_heading()} message={m.not_found_message()} />;
}
export function ErrorPage() {
  return <StatusPage heading={m.error_heading()} message={m.error_message()} />;
}
