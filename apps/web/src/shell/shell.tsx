import { Button } from '@rezics/ui/button';
import { LocaleProvider } from '@rezics/ui/locale';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@rezics/ui/menu';
import { ChoiceSelect } from '@rezics/ui/select';
import { SkipNavContent, SkipNavLink } from '@rezics/ui/skip-nav';
import {
  BottomNavigation,
  BottomNavigationItem,
  BottomNavigationItemIcon,
  BottomNavigationItemLabel,
  BottomNavigationList,
} from '@rezics/ui/bottom-navigation';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from '@rezics/ui/sidebar';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { getLocale, locales, setLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useEffect, useRef, useState } from 'react';
import { House, LogIn, LogOut, Menu as MenuIcon, Monitor, Moon, Sun, X } from 'lucide-react';
import type { SessionState } from '../session/state.ts';

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
const messages = {
  shell_skip_to_content: m.shell_skip_to_content,
  shell_navigation: m.shell_navigation,
  shell_language: m.shell_language,
  shell_theme: m.shell_theme,
  shell_theme_system: m.shell_theme_system,
  shell_theme_light: m.shell_theme_light,
  shell_theme_dark: m.shell_theme_dark,
  nav_home: m.nav_home,
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
const destinations = [{ to: '/', message: messages.nav_home, icon: House, phone: true }] as const;

function Mark() {
  return (
    <svg aria-hidden="true" viewBox="0 142.857 1000 714.286" className="h-5 w-7 shrink-0 fill-brand">
      <path d="M0 571.429 642.857 142.857 571.429 428.571 1000 142.857v285.714L357.143 857.143l71.428-285.714L0 857.143Z" />
    </svg>
  );
}
function Logo({ locale: _locale, showWordmarkOnMobile = false }: { locale: string; showWordmarkOnMobile?: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <Link
      to="/"
      aria-label="REZICS"
      onClick={() => isMobile && setOpenMobile(false)}
      className="flex h-10 shrink-0 items-center gap-2.5 rounded-xl px-1.5"
    >
      <Mark />
      <span
        className={`${showWordmarkOnMobile ? 'inline' : 'hidden sm:inline'} font-extrabold text-[15px] text-foreground tracking-[0.28em]`}
      >
        REZICS
      </span>
    </Link>
  );
}
function Navigation({ current }: { current: string }) {
  const { setOpenMobile, isMobile } = useSidebar();
  return (
    <>
      {isMobile && (
        <SidebarHeader className="flex-row items-center justify-between">
          <Logo locale={getLocale()} showWordmarkOnMobile />
          <Button
            variant="ghost"
            size="icon-md"
            aria-label={m.shell_close_navigation()}
            onClick={() => setOpenMobile(false)}
          >
            <X aria-hidden="true" />
          </Button>
        </SidebarHeader>
      )}
      <nav aria-label={m.shell_navigation()}>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {destinations.map((item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={current === item.to} tooltip={item.message()}>
                      <Link to={item.to} onClick={() => setOpenMobile(false)} data-autofocus className="text-primary">
                        <Icon aria-hidden="true" className="size-5" />
                        <span>{item.message()}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </nav>
    </>
  );
}
function NavigationToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { setOpenMobile, openMobile, isMobile } = useSidebar();
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!isMobile) return;
    if (openMobile) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const frame = requestAnimationFrame(() => trigger.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isMobile, openMobile]);
  return (
    <>
      <Button
        ref={trigger}
        className="md:hidden"
        variant="ghost"
        size="icon-md"
        aria-label={m.shell_open_navigation()}
        onClick={() => setOpenMobile(true)}
      >
        <MenuIcon aria-hidden="true" />
      </Button>
      <Button
        className="hidden md:inline-flex"
        variant="ghost"
        size="icon-md"
        aria-label={collapsed ? m.shell_expand_navigation() : m.shell_collapse_navigation()}
        onClick={onToggle}
      >
        <MenuIcon aria-hidden="true" />
      </Button>
    </>
  );
}
function ThemeControl() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : typeof document !== 'undefined' && document.documentElement.classList.contains('light')
        ? 'light'
        : 'system',
  );
  const icons = { system: Monitor, light: Sun, dark: Moon };
  const Icon = icons[theme];
  const choose = (value: string) => {
    const next = value as typeof theme;
    setTheme(next);
    document.documentElement.classList.remove('light', 'dark');
    if (next !== 'system') document.documentElement.classList.add(next);
    document.cookie = `rezics_theme=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon-md" aria-label={m.shell_theme()} title={m.shell_theme()}>
          <Icon aria-hidden="true" className="size-5" />
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuRadioGroup heading={m.shell_theme()} value={theme} onValueChange={(d) => choose(d.value)}>
          <MenuRadioItem value="system">{m.shell_theme_system()}</MenuRadioItem>
          <MenuRadioItem value="light">{m.shell_theme_light()}</MenuRadioItem>
          <MenuRadioItem value="dark">{m.shell_theme_dark()}</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
function LanguageControl() {
  const locale = getLocale();
  const change = async (value: string) => {
    if (!value || value === locale) return;
    const next = value as typeof locale;
    document.cookie = `rezics_locale=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
    await setLocale(next);
  };
  const options = locales.map((value) => ({ value, label: names[value], lang: value }));
  return (
    <>
      <div data-language-js>
        <ChoiceSelect
          label={m.shell_language()}
          value={locale}
          options={options}
          className="h-9 max-w-32"
          onValueChange={change}
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
function SessionControl({ session }: { session: SessionState }) {
  const location = useLocation();
  const className = 'size-9 p-0 sm:w-auto sm:px-3.5';
  if (session === 'unavailable') return null;
  if (session === 'signed-in')
    return (
      <form method="post" action="/auth/sign-out">
        <Button type="submit" variant="outline" className={className}>
          <LogOut aria-hidden="true" className="size-5" />
          <span className="sr-only sm:not-sr-only">{m.account_sign_out()}</span>
        </Button>
      </form>
    );
  const returnTo = location.publicHref.split('#')[0]!;
  return (
    <Button asChild variant="outline" className={className}>
      <a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}>
        <LogIn aria-hidden="true" className="size-5" />
        <span className="sr-only sm:not-sr-only">{m.account_sign_in()}</span>
      </a>
    </Button>
  );
}
export function AppShell({
  children,
  theme = 'system',
  collapsed = false,
  session,
}: {
  children: React.ReactNode;
  theme?: string;
  collapsed?: boolean;
  session: SessionState;
}) {
  const location = useLocation();
  const router = useRouter();
  const locale = getLocale();
  const [railCollapsed, setRailCollapsed] = useState(collapsed);
  useEffect(() => {
    const unsub = router.subscribe('onResolved', () => document.getElementById('main-content')?.focus());
    return unsub;
  }, [router]);
  const setCollapsed = (value: boolean) => {
    setRailCollapsed(value);
    document.cookie = `rezics_nav=${value ? 'collapsed' : 'expanded'}; Max-Age=31536000; Path=/; SameSite=Lax`;
  };
  return (
    <LocaleProvider locale={locale}>
      <SidebarProvider className="flex-col" open={!railCollapsed} onOpenChange={(open) => setCollapsed(!open)}>
        <SkipNavLink id="main-content">{m.shell_skip_to_content()}</SkipNavLink>
        <link
          rel="preload"
          href="/node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/90 backdrop-blur">
          <div className="flex h-16 items-center gap-2 px-3">
            <NavigationToggle collapsed={railCollapsed} onToggle={() => setCollapsed(!railCollapsed)} />
            <Logo locale={locale} />
            <div className="ms-auto flex items-center gap-2">
              <LanguageControl />
              <ThemeControl />
              <SessionControl session={session} />
            </div>
          </div>
        </header>
        <div className="flex min-h-[calc(100dvh-4rem)]">
          <Sidebar collapsible="icon" style={{ top: '4rem', bottom: 0, height: 'auto' }}>
            <Navigation current={location.pathname} />
          </Sidebar>
          <SkipNavContent asChild id="main-content" className="min-w-0 flex-1">
            <main className="min-h-[calc(100dvh-4rem)] min-w-0 p-6 pb-24 outline-none md:pb-6">
              <div className="mx-auto w-full max-w-5xl">{children}</div>
            </main>
          </SkipNavContent>
        </div>
        <BottomNavigation aria-label={m.shell_navigation()} className="md:hidden">
          <BottomNavigationList>
            {destinations
              .filter((item) => item.phone)
              .map((item) => {
                const Icon = item.icon;
                return (
                  <BottomNavigationItem key={item.to} asChild active={location.pathname === item.to}>
                    <Link to={item.to}>
                      <BottomNavigationItemIcon>
                        <Icon />
                      </BottomNavigationItemIcon>
                      <BottomNavigationItemLabel>{item.message()}</BottomNavigationItemLabel>
                    </Link>
                  </BottomNavigationItem>
                );
              })}
          </BottomNavigationList>
        </BottomNavigation>
      </SidebarProvider>
    </LocaleProvider>
  );
}
export function HomePage() {
  return <h1 className="font-serif text-3xl">{m.home_heading()}</h1>;
}
export function NotFoundPage() {
  return (
    <>
      <h1 className="font-serif text-3xl">{m.not_found_heading()}</h1>
      <p>{m.not_found_message()}</p>
    </>
  );
}
export function ErrorPage() {
  return (
    <>
      <h1 className="font-serif text-3xl">{m.error_heading()}</h1>
      <p>{m.error_message()}</p>
    </>
  );
}
