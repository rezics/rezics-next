'use client';

import { materializeData } from 'native-i18n';
import { createContext, use, useMemo, useRef, useState, type ReactNode } from 'react';
import { type OperationGate, gateFor, type PlatformAccess } from '../api/platform-access.ts';
import { saveDisplayPreference } from '../api/preferences.ts';
import type { UiLocale } from '../../i18n/define.ts';
import type { ShellMessages } from './messages.ts';
import { NAV_COOKIE, preferenceCookie, THEME_COOKIE, themeClass, type Theme } from './preferences.ts';

interface ShellState {
  locale: UiLocale;
  /** Whether a session exists: personal reads such as the unread count start only then. */
  signedIn: boolean;
  /** Which closed operations this viewer may use, read once for the request; client components gate on it. */
  operationOpen: OperationGate;
  /** Shell strings, materialized for client components and route boundaries. */
  t: ReturnType<typeof materializeData<ShellMessages>>;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  theme: Theme;
  /** The reader's choice: applied at once, kept in the first-paint cookie and, signed in, saved to the Account. */
  setTheme: (theme: Theme) => void;
  /** Applies the Account's saved value without writing it back. */
  adoptTheme: (theme: Theme) => void;
  /** True after the Account refused or could not take a display-mode choice. */
  themeNotSaved: boolean;
  dismissThemeNotice: () => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const state = use(ShellContext);
  if (!state) throw new Error('useShell must be used inside <ShellProvider>');
  return state;
}

export function useOptionalShell(): ShellState | null {
  return use(ShellContext);
}

const everythingOpen: OperationGate = () => true;

/**
 * The viewer's operation gate. Outside a shell, as in stories and component tests, nobody is being decided
 * for, so every operation counts as open; the app's own layout always supplies the platform-access read.
 */
export function useOperationGate(): OperationGate {
  return useOptionalShell()?.operationOpen ?? everythingOpen;
}

function writeCookie(name: string, value: string) {
  document.cookie = preferenceCookie(name, value, location.protocol === 'https:');
}

export function ShellProvider({ locale, messages, initialTheme, initialCollapsed, signedIn = false, platformAccess,
  children }: {
  locale: UiLocale; messages: ShellMessages; initialTheme: Theme; initialCollapsed: boolean; signedIn?: boolean;
  /** Omitted only where no viewer is being decided for (stories); the layout always passes the request's read. */
  platformAccess?: PlatformAccess;
  children: ReactNode;
}) {
  const [collapsed, setCollapsedState] = useState(initialCollapsed);
  const [theme, setThemeState] = useState(initialTheme);
  const [themeNotSaved, setThemeNotSaved] = useState(false);
  const latestChoice = useRef(0);
  function apply(next: Theme) {
    setThemeState(next);
    writeCookie(THEME_COOKIE, next);
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    const applied = themeClass(next);
    if (applied) root.classList.add(applied);
  }
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const operationOpen = useMemo(() => platformAccess ? gateFor(platformAccess) : everythingOpen, [platformAccess]);
  const state: ShellState = {
    locale, signedIn, operationOpen, t, collapsed, theme,
    setCollapsed(next) {
      setCollapsedState(next);
      writeCookie(NAV_COOKIE, next ? 'collapsed' : 'expanded');
    },
    setTheme(next) {
      apply(next);
      if (!signedIn) return;
      setThemeNotSaved(false);
      const choice = ++latestChoice.current;
      // Only the newest choice's outcome is shown; an older one settling late must not say otherwise.
      void saveDisplayPreference({ displayMode: next }).then(result => {
        if (choice === latestChoice.current) setThemeNotSaved(result === 'failed');
      });
    },
    adoptTheme: apply,
    themeNotSaved,
    dismissThemeNotice: () => setThemeNotSaved(false),
  };
  return <ShellContext value={state}>
    <div className="group/shell min-h-dvh" data-nav={collapsed ? 'collapsed' : 'expanded'}>{children}</div>
  </ShellContext>;
}
