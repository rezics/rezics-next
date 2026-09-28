'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/avatar';
import { initials } from '@rezics/ui/avatar-initials';
import { Menu, MenuContent, MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator,
  MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '@rezics/ui/menu';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { localeNames, uiLocales, type UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { themes, type Theme } from '../shell/preferences.ts';
import { useShell } from '../shell/shell-provider.tsx';
import { BFF_PREFIX } from '../api/browser.ts';
import { currentVanityHandle } from '../onboarding/handle.ts';
import { agentName, type SessionAgent } from './acting-identity.ts';
import type { AuthMessages } from './messages.ts';
import type { Session } from './session.ts';
import { useSessionSync } from './session-sync.ts';


/** What the menu says about the session Agent. */
export function agentSummary(agent: SessionAgent, messages: AuthMessages): {
  text: string; attention: boolean } {
  switch (agent.status) {
    case 'selected': return { text: agentName(agent.agent, messages), attention: false };
    case 'unselected': return { text: messages.chooseAgent, attention: true };
    case 'ineligible': return { text: messages.agentNotEligible, attention: true };
    case 'none': return { text: messages.noAgent, attention: false };
    case 'unverified': return { text: agent.previous
      ? agentName({ iri: agent.previous, label: null }, messages) : messages.agentUnverified,
    attention: !agent.previous };
  }
}

function AttentionDot() {
  return <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />;
}

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function AccountIdentity({ session, messages, compact = false }: {
  session: Session; messages: AuthMessages; compact?: boolean;
}) {
  const { user } = session;
  const agent = agentSummary(session.agent, messages);
  const displayName = user.name || user.email || messages.accountMenu;
  const avatarName = session.agent.status === 'selected' ? agent.text : user.name;
  const handle = session.agent.status === 'selected'
    ? currentVanityHandle(session.agent.agent.handle) : null;
  return <>
    <Avatar size="lg">
      {session.agent.status === 'selected' && session.agent.agent.avatarUrl
        ? <AvatarImage src={`${BFF_PREFIX}${session.agent.agent.avatarUrl}`} alt="" /> : null}
      <AvatarFallback className="bg-accent font-semibold text-accent-foreground text-sm">
        {initials(avatarName || user.email, 'R')}</AvatarFallback>
    </Avatar>
    <span className={compact ? 'sr-only' : 'hidden min-w-0 flex-col leading-tight sm:flex'}>
      <span className="truncate font-medium text-sm">{agent.text}</span>
      <span className={`flex items-center gap-1 truncate text-xs ${agent.attention
        ? 'text-warning-foreground' : 'text-muted-foreground'}`}>
        {agent.attention ? <AttentionDot /> : null}
        <span className="truncate">{session.agent.status === 'selected'
          ? handle ? `@${handle}` : messages.chooseHandle : displayName}</span></span>
    </span>
  </>;
}

// The phone sheet loads on first use; see account-sheet.tsx.
const AccountSheet = lazy(() => import('./account-sheet.tsx'));
const warmSheet = () => { void import('./account-sheet.tsx'); };

/** The signed-in account menu uses submenus on desktop and a sheet on phones. */
export function AccountMenu({ session, messages, accountOrigin }: {
  session: Session; messages: AuthMessages; accountOrigin: string;
}) {
  const { locale, t, theme, setTheme } = useShell();
  useSessionSync(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMounted, setSheetMounted] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const localeForm = useRef<HTMLFormElement>(null);
  const localeField = useRef<HTMLInputElement>(null);
  const signOutForm = useRef<HTMLFormElement>(null);
  const returnField = useRef<HTMLInputElement>(null);
  const formId = useId();
  const displayName = session.user.name || session.user.email || messages.accountMenu;
  const agent = agentSummary(session.agent, messages);
  const themeLabels: Record<Theme, string> = { system: t.themeSystem, light: t.themeLight, dark: t.themeDark };
  const chooseLocale = (choice: UiLocale) => {
    if (!localeField.current || !localeForm.current) return;
    localeField.current.value = choice;
    localeForm.current.requestSubmit();
  };
  const switchAgent = () => window.location.assign(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(currentPath())}`);
  const signOut = () => {
    if (!signOutForm.current || !returnField.current) return;
    returnField.current.value = localizedPath('/', locale);
    signOutForm.current.requestSubmit();
  };
  return <>
    <div className="hidden sm:block">
      <Menu onSelect={({ value }) => {
        if (value === 'switch-agent') switchAgent();
        else if (value === 'sign-out') signOut();
      }}>
        <MenuTrigger aria-label={messages.accountMenu} data-hydrated={hydrated ? 'true' : undefined}
          className="inline-flex max-w-64 items-center gap-2
          rounded-full p-1 text-start outline-none hover:bg-accent/60 focus-visible:ring-2
          focus-visible:ring-ring sm:pe-3">
          <AccountIdentity session={session} messages={messages} />
        </MenuTrigger>
        <MenuContent className="w-72">
          <div className="px-2.5 py-2">
            <p className="truncate font-medium text-sm">{displayName}</p>
            {session.user.name && session.user.email
              ? <p className="truncate text-muted-foreground text-xs">{session.user.email}</p> : null}
          </div>
          <MenuSeparator />
          <MenuGroup heading={messages.actingAs}>
            <p className={`flex items-center gap-1.5 px-2.5 pb-1.5 text-sm ${agent.attention
              ? 'text-warning-foreground' : ''}`}>
              {agent.attention ? <AttentionDot /> : null}<span className="truncate">{agent.text}
                {session.agent.status === 'selected'
                  ? ` · ${currentVanityHandle(session.agent.agent.handle)
                    ? `@${session.agent.agent.handle}` : messages.chooseHandle}` : ''}</span></p>
            <MenuItem value="switch-agent">{messages.switchAgent}</MenuItem>
            <MenuItem value="profile-settings" asChild><LocalizedLink
              href={localizedPath('/settings', locale)}>{messages.profileSettings}</LocalizedLink></MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuSub>
            <MenuSubTrigger>{t.language}</MenuSubTrigger>
            <MenuSubContent className="w-48">
              <MenuRadioGroup heading={t.language} value={locale}
                onValueChange={details => chooseLocale(details.value as UiLocale)}>
                {uiLocales.map(choice => <MenuRadioItem key={choice} value={choice} lang={choice}>
                  {localeNames[choice]}</MenuRadioItem>)}
              </MenuRadioGroup>
            </MenuSubContent>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>{t.displayMode}</MenuSubTrigger>
            <MenuSubContent className="w-48">
              <MenuRadioGroup heading={t.displayMode} value={theme}
                onValueChange={details => setTheme(details.value as Theme)}>
                {themes.map(choice => <MenuRadioItem key={choice} value={choice}>
                  {themeLabels[choice]}</MenuRadioItem>)}
              </MenuRadioGroup>
            </MenuSubContent>
          </MenuSub>
          <MenuSeparator />
          <MenuItem value="manage-account" asChild><a href={accountOrigin}>{messages.manageAccount}</a></MenuItem>
          <MenuItem value="sign-out">{messages.signOut}</MenuItem>
        </MenuContent>
      </Menu>
    </div>
    <button type="button" aria-label={messages.accountMenu} data-hydrated={hydrated ? 'true' : undefined}
      aria-haspopup="dialog" aria-expanded={sheetOpen} onPointerEnter={warmSheet} onFocus={warmSheet}
      onTouchStart={warmSheet} onClick={() => { setSheetMounted(true); setSheetOpen(true); }}
      className="inline-flex items-center rounded-full p-1 outline-none hover:bg-accent/60
        focus-visible:ring-2 focus-visible:ring-ring sm:hidden">
      <AccountIdentity session={session} messages={messages} compact />
    </button>
    {sheetMounted ? <Suspense fallback={null}>
      <AccountSheet open={sheetOpen} onOpenChange={setSheetOpen} title={messages.accountMenu} closeLabel={t.close}>
        <div className="grid gap-5 overflow-y-auto px-5 py-4">
          <div><p className="font-medium">{displayName}</p>
            <p className="text-muted-foreground text-sm">{agent.text}
              {session.agent.status === 'selected'
                ? ` · ${currentVanityHandle(session.agent.agent.handle)
                  ? `@${session.agent.agent.handle}` : messages.chooseHandle}` : ''}</p></div>
          <button type="button" onClick={switchAgent} className="text-start text-sm">{messages.switchAgent}</button>
          <LocalizedLink href={localizedPath('/settings', locale)} className="text-sm">
            {messages.profileSettings}</LocalizedLink>
          <fieldset className="grid gap-2"><legend className="mb-1 font-semibold text-sm">{t.language}</legend>
            {uiLocales.map(choice => <label key={choice} className="flex min-h-10 items-center gap-3 text-sm"
              lang={choice}><input type="radio" name="account-language" checked={locale === choice}
                onChange={() => chooseLocale(choice)} />{localeNames[choice]}</label>)}
          </fieldset>
          <fieldset className="grid gap-2"><legend className="mb-1 font-semibold text-sm">{t.displayMode}</legend>
            {themes.map(choice => <label key={choice} className="flex min-h-10 items-center gap-3 text-sm">
              <input type="radio" name="account-theme" checked={theme === choice}
                onChange={() => setTheme(choice)} />{themeLabels[choice]}</label>)}
          </fieldset>
          <a href={accountOrigin} className="text-sm">{messages.manageAccount}</a>
          <button type="button" onClick={signOut} className="text-start text-sm">{messages.signOut}</button>
        </div>
      </AccountSheet>
    </Suspense> : null}
    <form ref={localeForm} method="post" action="/locale/select" hidden>
      <input ref={localeField} type="hidden" name="locale" defaultValue={locale} />
    </form>
    <form ref={signOutForm} id={formId} method="post" action="/sign-out" hidden>
      <input ref={returnField} type="hidden" name="next" defaultValue="/" />
    </form>
  </>;
}
