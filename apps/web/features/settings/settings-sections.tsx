'use client';

import { Button } from '@rezics/ui/button';
import { Card, CardContent } from '@rezics/ui/card';
import { ChoiceSelect } from '@rezics/ui/select';
import { Switch } from '@rezics/ui/switch';
import { materializeData } from 'native-i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { localeNames, uiLocales, type UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { LanguagePicker } from '../onboarding/language-picker.tsx';
import { messages as onboardingMessages } from '../onboarding/messages.ts';
import { useOptionalShell } from '../shell/shell-provider.tsx';
import type { SettingsMessages } from './messages.ts';

type Channel = 'inbox' | 'email';
type NotificationChoice = { purpose: 'social' | 'subscription'; topic: string;
  channel: Channel; state: 'enabled' | 'disabled'; revision: string | null };
type Library = { visibility: 'public' | 'private' | 'followers'; version: number };
type Reader = { profile: 'reader-settings-v1'; fontSize: 15 | 17 | 19 | 22 | 25;
  lineWidth: 'narrow' | 'medium' | 'wide'; typeface: 'serif' | 'sans'; paragraphIndent: boolean;
  theme: 'system' | 'light' | 'dark'; cjkSpacing: 'auto' | 'none';
  cjkPunctuation: 'standard' | 'strict'; version: number };
type PersonPreferences = { profile: 'person-preferences-v1'; profileVisibility: 'public' | 'private';
  followPolicy: 'everyone' | 'nobody'; hideReadingActivity: boolean; contentLanguages: string[];
  spoilerPolicy: 'hide-unread' | 'show'; adultContent: boolean; version: number; blockedPeople: string[] };
const previewPerson: PersonPreferences = { profile: 'person-preferences-v1', profileVisibility: 'public',
  followPolicy: 'everyone', hideReadingActivity: false, contentLanguages: [],
  spoilerPolicy: 'hide-unread', adultContent: false, version: 0, blockedPeople: [] };

const topics = [
  ['social', 'reply', 'notificationReply'],
  ['social', 'mention', 'notificationMention'],
  ['social', 'post-vote', 'notificationPostVote'],
  ['subscription', 'followed-chapter', 'notificationFollowedChapter'],
  ['social', 'review-helpful', 'notificationReviewHelpful'],
  ['social', 'review', 'notificationReview'],
] as const;

async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${BFF_PREFIX}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}
async function write<T>(path: string, body: Record<string, unknown>, bodyKey = false): Promise<T> {
  const key = crypto.randomUUID();
  const response = await fetch(`${BFF_PREFIX}${path}`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(bodyKey ? { ...body, idempotencyKey: key } : body) });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

function Section({ id, title, help, children }: { id: string; title: string; help: string;
  children: ReactNode }) {
  return <Card id={id}><CardContent className="grid gap-5 p-5 sm:p-6">
    <div className="grid gap-1"><h2 className="font-semibold text-xl">{title}</h2>
      <p className="text-muted-foreground text-sm">{help}</p></div>
    {children}
  </CardContent></Card>;
}

function Notifications({ t, preview = false }: { t: SettingsMessages; preview?: boolean }) {
  const [choices, setChoices] = useState<NotificationChoice[] | null>(preview ? topics.flatMap(([purpose, topic]) =>
    (['inbox', 'email'] as const).map(channel => ({ purpose, topic, channel,
      state: 'enabled' as const, revision: null }))) : null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState('');
  useEffect(() => {
    if (preview) return;
    let active = true;
    void read<{ items: NotificationChoice[] }>('/v1/me/notification-preferences')
      .then(value => { if (active) setChoices(value.items); })
      .catch(() => { if (active) setStatus(t.notificationUnavailable); });
    return () => { active = false; };
  }, [preview, t]);
  const save = async (choice: NotificationChoice, checked: boolean) => {
    const key = `${choice.topic}:${choice.channel}`;
    setSaving(key); setStatus('');
    try {
      const result = await write<{ state: NotificationChoice['state']; revision: string }>(
        '/v1/me/notification-preferences', { profile: 'notification-preference-v1',
          purpose: choice.purpose, topic: choice.topic, channel: choice.channel,
          state: checked ? 'enabled' : 'disabled', expectedRevision: choice.revision }, true);
      setChoices(current => current?.map(item => item.topic === choice.topic && item.channel === choice.channel
        ? { ...item, state: result.state, revision: result.revision } : item) ?? null);
      setStatus(t.notificationSaved);
    } catch (error) { setStatus(String(error).includes('409') ? t.sectionStale : t.sectionFailed); }
    setSaving('');
  };
  return <Section id="notifications" title={t.notificationsTitle} help={t.notificationsHelp}>
    {choices ? <div className="grid gap-0">
      <div className="grid grid-cols-[minmax(0,1fr)_4rem_4rem] gap-2 border-b pb-2 text-muted-foreground text-xs
        sm:grid-cols-[minmax(0,1fr)_5rem_5rem]">
        <span>{t.notificationType}</span><span className="text-center">{t.notificationInbox}</span>
        <span className="text-center">{t.notificationEmail}</span></div>
      {topics.map(([purpose, topic, label]) => <div key={topic}
        className="grid min-h-12 grid-cols-[minmax(0,1fr)_4rem_4rem] items-center gap-2 border-b border-border/50 py-2
          text-sm last:border-0 sm:grid-cols-[minmax(0,1fr)_5rem_5rem]">
        <span className="min-w-0">{t[label]}</span>
        {(['inbox', 'email'] as const).map(channel => {
          const choice = choices.find(item => item.purpose === purpose && item.topic === topic && item.channel === channel);
          return <span key={channel} className="flex justify-center"><Switch size="sm"
            aria-label={`${t[label]} · ${channel === 'inbox' ? t.notificationInbox : t.notificationEmail}`}
            checked={choice?.state === 'enabled'} disabled={!choice || !!saving || preview}
            onCheckedChange={details => { if (choice) void save(choice, details.checked); }} /></span>;
        })}</div>)}
    </div> : <p role="status" className="text-muted-foreground text-sm">{status || '…'}</p>}
    {choices && status ? <p role="status" className="text-sm">{status}</p> : null}
  </Section>;
}

function Privacy({ agent, t, preview = false, extra }: { agent: string | null; t: SettingsMessages;
  preview?: boolean; extra?: ReactNode }) {
  const [current, setCurrent] = useState<Library | null>(preview ? { visibility: 'private', version: 0 } : null);
  const [draft, setDraft] = useState<Library['visibility']>('private');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const path = agent ? `/v1/agents/${agent.slice(-36)}/library-visibility` : null;
  useEffect(() => {
    if (!path || preview) return;
    let active = true;
    void read<Library>(path).then(value => { if (active) {
      setCurrent(value); setDraft(value.visibility);
    } }).catch(() => { if (active) setStatus(t.libraryUnavailable); });
    return () => { active = false; };
  }, [path, preview, t]);
  const save = async () => {
    if (!path || !current || draft === 'followers') return;
    setBusy(true); setStatus('');
    try {
      const value = await write<Library>(path, { visibility: draft, expectedVersion: current.version });
      setCurrent(value); setStatus(t.librarySaved);
    } catch (error) { setStatus(String(error).includes('409') ? t.sectionStale : t.sectionFailed); }
    setBusy(false);
  };
  return <Section id="privacy" title={t.privacyTitle} help={t.privacyHelp}>
    {current ? <div className="flex flex-wrap items-end gap-3"><label className="grid min-w-48 flex-1 gap-1 text-sm font-medium">
      {t.libraryVisibility}<ChoiceSelect label={t.libraryVisibility} value={draft} disabled={busy || preview}
        options={[{ value: 'public', label: t.libraryPublic }, { value: 'private', label: t.libraryPrivate },
          ...(current.visibility === 'followers' ? [{ value: 'followers', label: t.libraryFollowers }] : [])]}
        onValueChange={value => setDraft(value === 'public' || value === 'followers' ? value : 'private')} /></label>
      <Button type="button" onClick={() => void save()}
        disabled={busy || preview || draft === 'followers' || draft === current.visibility}>
        {t.saveSection}</Button></div> : <p role="status" className="text-muted-foreground text-sm">{status || '…'}</p>}
    {current && status ? <p role="status" className="text-sm">{status}</p> : null}
    {extra}
  </Section>;
}

function Reading({ agent, t, preview = false, extra }: { agent: string | null; t: SettingsMessages;
  preview?: boolean; extra?: ReactNode }) {
  const sample: Reader = { profile: 'reader-settings-v1', fontSize: 17, lineWidth: 'medium', typeface: 'serif',
    paragraphIndent: false, theme: 'system', cjkSpacing: 'auto', cjkPunctuation: 'standard', version: 0 };
  const [current, setCurrent] = useState<Reader | null>(preview ? sample : null);
  const [draft, setDraft] = useState<Reader>(sample);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!agent || preview) return;
    let active = true;
    void read<Reader>(`/v1/reader/settings?actingSubject=${encodeURIComponent(agent)}`)
      .then(value => { if (active) { setCurrent(value); setDraft(value); } })
      .catch(() => { if (active) setStatus(t.readerUnavailable); });
    return () => { active = false; };
  }, [agent, preview, t]);
  const save = async () => {
    if (!agent || !current) return;
    setBusy(true); setStatus('');
    try {
      const { profile: _profile, version: _version, ...values } = draft;
      const value = await write<Reader>('/v1/reader/settings', { actingSubject: agent,
        expectedVersion: current.version, ...values });
      setCurrent(value); setDraft(value); setStatus(t.readerSaved);
    } catch (error) { setStatus(String(error).includes('409') ? t.sectionStale : t.sectionFailed); }
    setBusy(false);
  };
  const option = (value: string, label: string) => ({ value, label });
  return <Section id="reading" title={t.readingTitle} help={t.readingHelp}>
    {current ? <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">{t.readerFontSize}
          <ChoiceSelect label={t.readerFontSize} value={String(draft.fontSize)} disabled={busy || preview}
            options={([15, 17, 19, 22, 25] as const).map(size => option(String(size), `${size} px`))}
            onValueChange={value => setDraft(old => ({ ...old, fontSize: Number(value) as Reader['fontSize'] }))} />
        </label>
        <label className="grid gap-1 text-sm font-medium">{t.readerLineWidth}
          <ChoiceSelect label={t.readerLineWidth} value={draft.lineWidth} disabled={busy || preview}
            options={[option('narrow', t.readerNarrow), option('medium', t.readerMedium), option('wide', t.readerWide)]}
            onValueChange={value => setDraft(old => ({ ...old, lineWidth: value as Reader['lineWidth'] }))} />
        </label>
        <label className="grid gap-1 text-sm font-medium">{t.readerTypeface}
          <ChoiceSelect label={t.readerTypeface} value={draft.typeface} disabled={busy || preview}
            options={[option('serif', t.readerSerif), option('sans', t.readerSans)]}
            onValueChange={value => setDraft(old => ({ ...old, typeface: value as Reader['typeface'] }))} />
        </label>
        <div className="flex items-center gap-3 text-sm"><Switch aria-label={t.readerIndent}
          checked={draft.paragraphIndent} disabled={busy || preview}
          onCheckedChange={details => setDraft(old => ({ ...old, paragraphIndent: details.checked }))} />
          <span>{t.readerIndent}</span></div>
      </div>
      <Button type="button" className="w-fit" disabled={busy || preview || JSON.stringify(draft) === JSON.stringify(current)}
        onClick={() => void save()}>{t.saveSection}</Button>
    </> : <p role="status" className="text-muted-foreground text-sm">{status || '…'}</p>}
    {current && status ? <p role="status" className="text-sm">{status}</p> : null}
    {extra}
  </Section>;
}

function PersonControls({ agent, locale, t, preview = false, previewLanguages = [] }: { agent: string;
  locale: UiLocale; t: SettingsMessages; preview?: boolean; previewLanguages?: readonly string[] }) {
  const languageT = materializeData(onboardingMessages[locale], { locale });
  const [current, setCurrent] = useState<PersonPreferences | null>(preview
    ? { ...previewPerson, contentLanguages: [...previewLanguages] } : null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [blockName, setBlockName] = useState('');
  const [languages, setLanguages] = useState<string[]>(preview ? [...previewLanguages] : []);
  const [suggested, setSuggested] = useState<string[]>(preview
    ? ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] : []);
  const path = `/v1/me/person-preferences?actingSubject=${encodeURIComponent(agent)}`;
  const reload = async () => {
    const value = await read<PersonPreferences>(path);
    setCurrent(value);
    setLanguages(value.contentLanguages);
    return value;
  };
  useEffect(() => {
    if (preview) return;
    let active = true;
    void read<PersonPreferences>(path).then(value => {
      if (!active) return;
      setCurrent(value); setLanguages(value.contentLanguages);
    }).catch(() => { if (active) setStatus(t.personUnavailable); });
    void fetch(`${BFF_PREFIX}/v1/onboarding/choices?locale=${encodeURIComponent(locale)}`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() as Promise<{ languages?: unknown }> : null)
      .then(value => {
        if (!active || !value || !Array.isArray(value.languages)) return;
        setSuggested(value.languages.filter((language): language is string => typeof language === 'string'));
      }).catch(() => { /* suggestions are optional; any tag can still be typed */ });
    return () => { active = false; };
  }, [path, preview, t, locale]);
  const save = async (patch: Partial<PersonPreferences>) => {
    if (!current || busy || preview) return;
    setBusy(true); setStatus('');
    try {
      const { profile: _profile, version: _version, blockedPeople: _blocked, ...prior } = current;
      const next = await write<PersonPreferences>('/v1/me/person-preferences', {
        actingSubject: agent, expectedVersion: current.version, ...prior, contentLanguages: languages, ...patch });
      setCurrent(next); setLanguages(next.contentLanguages); setStatus(t.personSaved);
    } catch (error) {
      const conflict = String(error).includes('409');
      setStatus(conflict ? t.sectionStale : t.sectionFailed);
      if (conflict) await reload().catch(() => { /* the conflict message stays */ });
    }
    setBusy(false);
  };
  const block = async (target: string, blocked: boolean) => {
    if (busy || preview) return;
    setBusy(true); setStatus('');
    try {
      await write('/v1/me/blocked-people', { actingSubject: agent, target: target.trim(), blocked });
      const next = await read<PersonPreferences>(path);
      setCurrent(next); setBlockName(''); setStatus(blocked ? t.personBlocked : t.personUnblocked);
    } catch { setStatus(t.sectionFailed); }
    setBusy(false);
  };
  const privacy = <div className="grid gap-4 border-t pt-5">
    <div className="grid gap-1"><h3 className="font-medium">{t.profilePrivacyTitle}</h3>
      <p className="text-muted-foreground text-sm">{t.profilePrivacyHelp}</p></div>
    {current ? <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">{t.profileVisibility}
          <ChoiceSelect label={t.profileVisibility} value={current.profileVisibility} disabled={busy || preview}
            options={[{ value: 'public', label: t.libraryPublic }, { value: 'private', label: t.libraryPrivate }]}
            onValueChange={value => void save({ profileVisibility: value === 'private' ? 'private' : 'public' })} />
        </label>
        <label className="grid gap-1 text-sm font-medium">{t.whoCanFollow}
          <ChoiceSelect label={t.whoCanFollow} value={current.followPolicy} disabled={busy || preview}
            options={[{ value: 'everyone', label: t.followEveryone }, { value: 'nobody', label: t.followNobody }]}
            onValueChange={value => void save({ followPolicy: value === 'nobody' ? 'nobody' : 'everyone' })} />
        </label>
      </div>
      <div className="flex items-center gap-3 text-sm"><Switch aria-label={t.hideReadingActivity}
        checked={current.hideReadingActivity} disabled={busy || preview}
        onCheckedChange={details => void save({ hideReadingActivity: details.checked })} />
        <span>{t.hideReadingActivity}</span></div>
      <div className="grid gap-2"><h3 className="font-medium">{t.blockedPeople}</h3>
        <p className="text-muted-foreground text-sm">{t.blockedPeopleHelp}</p>
        <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void block(blockName, true); }}>
          <input className="min-w-48 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
            aria-label={t.blockPerson} placeholder={t.blockPlaceholder} value={blockName} disabled={busy || preview}
            onChange={event => setBlockName(event.target.value)} />
          <Button type="submit" disabled={busy || preview || !blockName.trim()}>{t.blockPerson}</Button>
        </form>
        {current.blockedPeople.length ? <ul className="grid gap-2">{current.blockedPeople.map(id =>
          <li key={id} className="flex items-center justify-between gap-2 text-sm">
            <span>{t.blockedPersonId} {id.slice(-8)}</span>
            <Button type="button" variant="soft" disabled={busy || preview}
              onClick={() => void block(id, false)}>{t.unblockPerson}</Button>
          </li>)}</ul> : <p className="text-muted-foreground text-sm">{t.noBlockedPeople}</p>}
      </div>
    </> : <p role="status" className="text-muted-foreground text-sm">{status || '…'}</p>}
  </div>;
  const content = <div className="grid gap-4 border-t pt-5">
    <div className="grid gap-1"><h3 className="font-medium">{t.contentPreferences}</h3>
      <p className="text-muted-foreground text-sm">{t.contentPreferencesHelp}</p></div>
    {current ? <>
      <LanguagePicker t={languageT} locale={locale} suggested={suggested} value={languages}
        onChange={next => { if (!busy) setLanguages(next); }} />
      <Button type="button" className="w-fit" disabled={busy || preview
        || languages.join() === current.contentLanguages.join()}
        onClick={() => void save({ contentLanguages: languages })}>{t.saveSection}</Button>
      <label className="grid gap-1 text-sm font-medium">{t.spoilerHandling}
        <ChoiceSelect label={t.spoilerHandling} value={current.spoilerPolicy} disabled={busy || preview}
          options={[{ value: 'hide-unread', label: t.spoilerHideUnread },
            { value: 'show', label: t.spoilerShow }]}
          onValueChange={value => void save({ spoilerPolicy: value === 'show' ? 'show' : 'hide-unread' })} />
      </label>
    </> : <p role="status" className="text-muted-foreground text-sm">{status || '…'}</p>}
  </div>;
  return <><Privacy agent={agent} t={t} preview={preview} extra={privacy} />
    <Reading agent={agent} t={t} preview={preview} extra={content} />
    {current && status ? <p role="status" className="text-sm">{status}</p> : null}</>;
}

function Display({ locale, t, preview = false }: { locale: UiLocale; t: SettingsMessages; preview?: boolean }) {
  const shell = useOptionalShell();
  const [language, setLanguage] = useState<UiLocale>(locale);
  const [theme, setTheme] = useState(shell?.theme ?? 'system');
  return <Section id="display" title={t.displayTitle} help={t.displayHelp}>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-medium">{t.themeLabel}
        <ChoiceSelect label={t.themeLabel} value={shell?.theme ?? theme} disabled={preview}
          options={[{ value: 'system', label: t.themeSystem }, { value: 'light', label: t.themeLight },
            { value: 'dark', label: t.themeDark }]}
          onValueChange={value => { setTheme(value as typeof theme); shell?.setTheme(value as typeof theme); }} />
      </label>
      <form action="/locale/select" method="post" className="grid gap-2">
        <label className="grid gap-1 text-sm font-medium">{t.interfaceLanguage}
          <ChoiceSelect label={t.interfaceLanguage} name="locale" value={language} disabled={preview}
            options={uiLocales.map(value => ({ value, label: localeNames[value] }))}
            onValueChange={value => setLanguage(value as UiLocale)} />
        </label>
        <Button type="submit" variant="soft" className="w-fit" disabled={preview || language === locale}>
          {t.languageSave}</Button>
      </form>
    </div>
  </Section>;
}

export function SettingsSections({ agent, locale, accountOrigin, t, preview = false, previewLanguages, children }: {
  agent: string | null; locale: UiLocale; accountOrigin: string; t: SettingsMessages; preview?: boolean;
  /** Story preview of a saved reading-language list. */
  previewLanguages?: readonly string[];
  children?: ReactNode;
}) {
  return <>
    <Notifications t={t} preview={preview} />
    {agent ? <PersonControls agent={agent} locale={locale} t={t} preview={preview}
      previewLanguages={previewLanguages} /> : null}
    <Display locale={locale} t={t} preview={preview} />
    {children}
    <Section id="account" title={t.accountTitle} help={t.accountHelp}>
      <a href={accountOrigin} className="w-fit font-medium text-primary underline underline-offset-4">{t.accountLink}</a>
    </Section>
  </>;
}
