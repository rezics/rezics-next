'use client';

import { materializeData } from 'native-i18n';
import { createContext, use, useMemo, useState, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { ShellMessages } from './messages.ts';
import { NAV_COOKIE, preferenceCookie, THEME_COOKIE, themeClass, type Theme } from './preferences.ts';

interface ShellState {
  locale: UiLocale;
  /** Shell strings, materialized for client components and route boundaries. */
  t: ReturnType<typeof materializeData<ShellMessages>>;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const state = use(ShellContext);
  if (!state) throw new Error('useShell must be used inside <ShellProvider>');
  return state;
}

function writeCookie(name: string, value: string) {
  document.cookie = preferenceCookie(name, value, location.protocol === 'https:');
}

export function ShellProvider({ locale, messages, initialTheme, initialCollapsed, children }: {
  locale: UiLocale; messages: ShellMessages; initialTheme: Theme; initialCollapsed: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsedState] = useState(initialCollapsed);
  const [theme, setThemeState] = useState(initialTheme);
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const state: ShellState = {
    locale, t, collapsed, theme,
    setCollapsed(next) {
      setCollapsedState(next);
      writeCookie(NAV_COOKIE, next ? 'collapsed' : 'expanded');
    },
    setTheme(next) {
      setThemeState(next);
      writeCookie(THEME_COOKIE, next);
      const root = document.documentElement;
      root.classList.remove('light', 'dark');
      const applied = themeClass(next);
      if (applied) root.classList.add(applied);
    },
  };
  return <ShellContext value={state}>
    <div className="group/shell min-h-dvh" data-nav={collapsed ? 'collapsed' : 'expanded'}>{children}</div>
  </ShellContext>;
}
