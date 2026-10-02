'use client';

import { Button } from '@rezics/ui/button';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/radio-group';
import { ArrowLeftIcon, ChevronRightIcon } from 'lucide-react';
import { accountMenuSections, accountRowName, contentPreferenceValue, type AccountContentPreferences } from './account-menu-items.ts';
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
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
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

/** The full value remains in the accessible name when the visible row truncates. */
function AccountRowValue({ label, value, lang }: { label: string; value: string; lang?: string }) {
  return <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-1">
    <span className="shrink-0">{label}</span><span className="text-muted-foreground">·</span>
    <span lang={lang} className="truncate text-muted-foreground">{value}</span>
  </span>;
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
  const agent = agentSummary(session.agent, messages);
  // The Account's own name and email are private; the menu shows only the Agent's public identity.
  const avatarName = session.agent.status === 'selected' ? agent.text : '';
  const handle = session.agent.status === 'selected'
    ? currentVanityHandle(session.agent.agent.handle) : null;
  return <>
    <Avatar size="lg">
      {session.agent.status === 'selected' && session.agent.agent.avatarUrl
        ? <AvatarImage src={`${BFF_PREFIX}${session.agent.agent.avatarUrl}`} alt="" /> : null}
      <AvatarFallback className="bg-accent font-semibold text-accent-foreground text-sm">
        {initials(avatarName, 'R')}</AvatarFallback>
    </Avatar>
    <span className={compact ? 'sr-only' : 'hidden min-w-0 flex-col leading-tight sm:flex'}>
      <span className="truncate font-medium text-sm">{agent.text}</span>
      <span className={`flex items-center gap-1 truncate text-xs ${agent.attention
        ? 'text-warning-foreground' : 'text-muted-foreground'}`}>
        {agent.attention ? <AttentionDot /> : null}
        <span className="truncate">{session.agent.status === 'selected'
          ? handle ? `@${handle}` : messages.chooseHandle : ''}</span></span>
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
  const [menuOpen, setMenuOpen] = useState(false);
  const actingSubject = session.agent.status === 'selected' ? session.agent.agent.iri : null;
  const [content, setContent] = useState<{ agent: string; value: AccountContentPreferences | null } | null>(null);
  useEffect(() => {
    if (!(menuOpen || sheetOpen) || !actingSubject) return;
    let current = true;
    setContent(null);
    void browserMainApi().v1.me['person-preferences'].get({ query: { actingSubject } })
      .then(({ data }) => { if (current) setContent({ agent: actingSubject, value: data ?? null }); },
        () => { if (current) setContent({ agent: actingSubject, value: null }); });
    return () => { current = false; };
  }, [menuOpen, sheetOpen, actingSubject]);
  const [panel, setPanel] = useState<'language' | 'appearance' | null>(null);
  const phoneTrigger = useRef<HTMLButtonElement>(null);
  const panelBody = useRef<HTMLDivElement>(null);
  const previousPanel = useRef<string | null>(null);
  useEffect(() => {
    if (!sheetOpen) return;
    const frame = requestAnimationFrame(() => {
      const target = panel ? panelBody.current?.querySelector<HTMLButtonElement>('[data-back]')
        : previousPanel.current ? panelBody.current?.querySelector<HTMLButtonElement>(`[data-panel="${previousPanel.current}"]`) : null;
      target?.focus();
      previousPanel.current = panel;
    });
    return () => cancelAnimationFrame(frame);
  }, [panel, sheetOpen]);
  const [sheetMounted, setSheetMounted] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const localeForm = useRef<HTMLFormElement>(null);
  const localeField = useRef<HTMLInputElement>(null);
  const signOutForm = useRef<HTMLFormElement>(null);
  const returnField = useRef<HTMLInputElement>(null);
  const formId = useId();
  const agent = agentSummary(session.agent, messages);
  const sections = accountMenuSections(session, messages);
  const themeLabels: Record<Theme, string> = { system: t.themeSystem, light: t.themeLight, dark: t.themeDark };
  const contentValue = !actingSubject ? messages.preferencesUnavailable
    : content?.agent !== actingSubject ? messages.preferencesLoading
    : content.value ? contentPreferenceValue(content.value, locale, messages) : messages.preferencesUnavailable;
  const rowValue = (id: string) => id === 'language' ? localeNames[locale]
    : id === 'appearance' ? themeLabels[theme] : contentValue;
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
      <Menu onOpenChange={({ open }) => setMenuOpen(open)} onSelect={({ value }) => {
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
          <MenuGroup heading={messages.actingAs}>
            <p className={`flex items-center gap-1.5 px-2.5 pb-1.5 text-sm ${agent.attention
              ? 'text-warning-foreground' : ''}`}>
              {agent.attention ? <AttentionDot /> : null}<span className="truncate">{agent.text}
                {session.agent.status === 'selected'
                  ? ` · ${currentVanityHandle(session.agent.agent.handle)
                    ? `@${session.agent.agent.handle}` : messages.chooseHandle}` : ''}</span></p>
            <MenuItem value="switch-agent">{messages.switchAgent}</MenuItem>
          </MenuGroup>
          {sections.map((section, index) => <div key={index}>
            <MenuSeparator />
            {section.map(entry => 'panel' in entry ? <MenuSub key={entry.id}>
              <MenuSubTrigger aria-label={accountRowName(entry.label, rowValue(entry.id))}>
                <AccountRowValue label={entry.label} value={rowValue(entry.id)} lang={entry.id === 'language' ? locale : undefined} />
              </MenuSubTrigger>
              <MenuSubContent className="w-52">
                <MenuRadioGroup heading={entry.label} value={entry.id === 'language' ? locale : theme}
                  onValueChange={({ value }) => entry.id === 'language' ? chooseLocale(value as UiLocale) : setTheme(value as Theme)}>
                  {entry.id === 'language' ? uiLocales.map(choice => <MenuRadioItem key={choice} value={choice} lang={choice}>
                    {localeNames[choice]}</MenuRadioItem>) : themes.map(choice => <MenuRadioItem key={choice} value={choice}>
                    {themeLabels[choice]}</MenuRadioItem>)}
                </MenuRadioGroup>
              </MenuSubContent>
            </MenuSub> : <MenuItem key={entry.id} value={entry.id} asChild>
              <LocalizedLink href={localizedPath(entry.href, locale)} aria-label={entry.arrow ? accountRowName(entry.label, rowValue(entry.id)) : undefined}>
                {entry.arrow ? <AccountRowValue label={entry.label} value={rowValue(entry.id)} /> : entry.label}
                {entry.arrow ? <ChevronRightIcon aria-hidden="true" className="ms-auto size-4" /> : null}
              </LocalizedLink></MenuItem>)}
          </div>)}
          <MenuSeparator />
          <MenuItem value="manage-account" asChild><a href={accountOrigin}>{messages.manageAccount}</a></MenuItem>
          <MenuItem value="sign-out">{messages.signOut}</MenuItem>
        </MenuContent>
      </Menu>
    </div>
    <Button ref={phoneTrigger} variant="ghost" type="button" aria-label={messages.accountMenu} data-hydrated={hydrated ? 'true' : undefined}
      aria-haspopup="dialog" aria-expanded={sheetOpen} onPointerEnter={warmSheet} onFocus={warmSheet}
      onTouchStart={warmSheet} onClick={() => { setPanel(null); previousPanel.current = null; setSheetMounted(true); setSheetOpen(true); }}
      className="inline-flex items-center rounded-full p-1 outline-none hover:bg-accent/60
        focus-visible:ring-2 focus-visible:ring-ring sm:hidden">
      <AccountIdentity session={session} messages={messages} compact />
    </Button>
    {sheetMounted ? <Suspense fallback={null}>
      <AccountSheet open={sheetOpen} onOpenChange={setSheetOpen} title={panel ? messages[panel] : messages.accountMenu}
        closeLabel={t.close} returnFocus={() => phoneTrigger.current}>
        <div className="min-h-0 overflow-y-auto">
          <div ref={panelBody} className="grid gap-1 px-5 py-3">
            {panel ? <>
              <Button data-back type="button" variant="ghost" className="justify-start" onClick={() => setPanel(null)}>
                <ArrowLeftIcon aria-hidden="true" />{messages.back}</Button>
              <RadioGroup name={`account-${panel}`} className="gap-1 py-3" aria-label={messages[panel]}
                value={panel === 'language' ? locale : theme}
                onValueChange={({ value }) => panel === 'language' ? chooseLocale(value as UiLocale) : setTheme(value as Theme)}>
                {panel === 'language' ? uiLocales.map(choice => <RadioGroupItem key={choice} value={choice}
                  lang={choice} className="min-h-11 items-center rounded-xl px-3">{localeNames[choice]}</RadioGroupItem>)
                  : themes.map(choice => <RadioGroupItem key={choice} value={choice}
                    className="min-h-11 items-center rounded-xl px-3">{themeLabels[choice]}</RadioGroupItem>)}
              </RadioGroup>
            </> : <>
              <p className="px-3 py-2 text-muted-foreground text-xs">{messages.actingAs}</p>
              <p className="truncate px-3 pb-2 font-medium">{agent.text}
                {session.agent.status === 'selected'
                  ? ` · ${currentVanityHandle(session.agent.agent.handle)
                    ? `@${session.agent.agent.handle}` : messages.chooseHandle}` : ''}</p>
              <Button type="button" variant="ghost" className="min-h-11 justify-start" onClick={switchAgent}>{messages.switchAgent}</Button>
              {sections.map((section, index) => <div key={index} className="grid gap-1 border-border/60 border-t py-2">
                {section.map(entry => 'panel' in entry ? <Button key={entry.id} data-panel={entry.id} type="button" variant="ghost"
                  className="min-h-11 justify-between" aria-label={accountRowName(entry.label, rowValue(entry.id))} onClick={() => setPanel(entry.id)}>
                  <AccountRowValue label={entry.label} value={rowValue(entry.id)} lang={entry.id === 'language' ? locale : undefined} /><ChevronRightIcon aria-hidden="true" /></Button>
                  : <Button key={entry.id} variant="ghost" className="min-h-11 justify-between" asChild>
                    <LocalizedLink href={localizedPath(entry.href, locale)} aria-label={entry.arrow ? accountRowName(entry.label, rowValue(entry.id)) : undefined}>
                      {entry.arrow ? <AccountRowValue label={entry.label} value={rowValue(entry.id)} /> : entry.label}
                      {entry.arrow ? <ChevronRightIcon aria-hidden="true" /> : null}</LocalizedLink></Button>)}
              </div>)}
              <Button variant="ghost" className="min-h-11 justify-start" asChild><a href={accountOrigin}>{messages.manageAccount}</a></Button>
              <Button type="button" variant="ghost" className="min-h-11 justify-start" onClick={signOut}>{messages.signOut}</Button>
            </>}
          </div>
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
