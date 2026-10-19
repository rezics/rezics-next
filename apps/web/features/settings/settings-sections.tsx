'use client';

import { Button } from '@rezics/ui/button';
import { Card, CardContent } from '@rezics/ui/card';
import { ChoiceSelect } from '@rezics/ui/select';
import { Switch } from '@rezics/ui/switch';
import { materializeData } from 'native-i18n';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { localeNames, uiLocales, type UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { forgetReadingLanguages } from '../content-language/use-reading-languages.ts';
import { LanguagePicker } from '../onboarding/language-picker.tsx';
import { messages as onboardingMessages } from '../onboarding/messages.ts';
import { useOptionalShell } from '../shell/shell-provider.tsx';
import { NotificationSettings } from './notification-settings.tsx';
import type { SettingsMessages } from './messages.ts';
import { languagesAfterRefresh, personPreferenceCommand, sameLanguages,
  type PersonPreferencePatch, type PersonPreferences } from './person-preferences.ts';
import { useRecoveryFocus } from './use-recovery-focus.ts';

export { notificationTopicLabel, settingsNotificationTopics, topicsShown } from './notification-settings.tsx';
type Library = { visibility: 'public' | 'private' | 'followers'; version: number };
type Reader = { profile: 'reader-settings-v1'; fontSize: 15 | 17 | 19 | 22 | 25;
  lineWidth: 'narrow' | 'medium' | 'wide'; typeface: 'serif' | 'sans'; paragraphIndent: boolean;
  theme: 'system' | 'light' | 'dark'; cjkSpacing: 'auto' | 'none';
  cjkPunctuation: 'standard' | 'strict'; version: number };
const previewPerson: PersonPreferences = { profile: 'person-preferences-v1', profileVisibility: 'public',
  followPolicy: 'everyone', hideReadingActivity: false, contentLanguages: [],
  spoilerPolicy: 'hide-unread', version: 0, blockedPeople: [] };

async function responseData<T>(request: Promise<{ data: T | null; error: unknown; status: number }>): Promise<T> {
  const response = await request;
  if (response.error || response.data === null) throw new Error(String(response.status));
  return response.data;
}
const commandOptions = () => ({ headers: { 'idempotency-key': crypto.randomUUID() } });

function Section({ id, title, help, children }: { id: string; title: string; help: string;
  children: ReactNode }) {
  return <Card id={id}><CardContent className="grid gap-5 p-5 sm:p-6">
    <div className="grid gap-1"><h2 className="font-semibold text-xl">{title}</h2>
      <p className="text-muted-foreground text-sm">{help}</p></div>
    {children}
  </CardContent></Card>;
}

function Privacy({ agent, t, preview = false, extra }: { agent: string | null; t: SettingsMessages;
  preview?: boolean; extra?: ReactNode }) {
  const [current, setCurrent] = useState<Library | null>(preview ? { visibility: 'private', version: 0 } : null);
  const [draft, setDraft] = useState<Library['visibility']>('private');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!agent || preview) return;
    let active = true;
    void responseData(browserMainApi().v1.agents({ id: agent.slice(-36) })['library-visibility'].get({
      fetch: { cache: 'no-store' },
    })).then(value => { if (active) {
      setCurrent(value); setDraft(value.visibility);
    } }).catch(() => { if (active) setStatus(t.libraryUnavailable); });
    return () => { active = false; };
  }, [agent, preview, t]);
  const save = async () => {
    if (!agent || !current || draft === 'followers') return;
    setBusy(true); setStatus('');
    try {
      const value = await responseData(browserMainApi().v1.agents({ id: agent.slice(-36) })['library-visibility']
        .put({ visibility: draft, expectedVersion: current.version }, commandOptions()));
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
    void responseData(browserMainApi().v1.reader.settings.get({
      query: { actingSubject: agent }, fetch: { cache: 'no-store' },
    }))
      .then(value => { if (active) { setCurrent(value); setDraft(value); } })
      .catch(() => { if (active) setStatus(t.readerUnavailable); });
    return () => { active = false; };
  }, [agent, preview, t]);
  const save = async () => {
    if (!agent || !current) return;
    setBusy(true); setStatus('');
    try {
      const { profile: _profile, version: _version, ...values } = draft;
      const value = await responseData(browserMainApi().v1.reader.settings.put({ actingSubject: agent,
        expectedVersion: current.version, ...values }, commandOptions()));
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
  const saving = useRef(false);
  const recoveryFocus = useRecoveryFocus(busy);
  const feedbackId = useId();
  const [activeSection, setActiveSection] = useState<'privacy' | 'content'>('content');
  const [pending, setPending] = useState<PersonPreferencePatch>({});
  const [failed, setFailed] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [blockName, setBlockName] = useState('');
  const [languages, setLanguages] = useState<string[]>(preview ? [...previewLanguages] : []);
  const [suggested, setSuggested] = useState<string[]>(preview
    ? ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] : []);
  const readPreferences = () => responseData(browserMainApi().v1.me['person-preferences'].get({
    query: { actingSubject: agent }, fetch: { cache: 'no-store' },
  }));
  const reload = async () => {
    const value = await readPreferences();
    if (current) setLanguages(languagesAfterRefresh(current, languages, value));
    setCurrent(value);
    setNeedsRefresh(false);
    return value;
  };
  useEffect(() => {
    if (preview) return;
    let active = true;
    void responseData(browserMainApi().v1.me['person-preferences'].get({
      query: { actingSubject: agent }, fetch: { cache: 'no-store' },
    })).then(value => {
      if (!active) return;
      setCurrent(value); setLanguages(value.contentLanguages);
    }).catch(() => { if (active) setStatus(t.personUnavailable); });
    void responseData(browserMainApi(undefined, { anonymous: true }).v1.onboarding.choices.get({
      query: { locale }, fetch: { cache: 'no-store' },
    }))
      .then(value => {
        if (!active || !value || !Array.isArray(value.languages)) return;
        setSuggested(value.languages.filter((language): language is string => typeof language === 'string'));
      }).catch(() => { /* suggestions are optional; any tag can still be typed */ });
    return () => { active = false; };
  }, [agent, preview, t, locale]);
  const save = async (patch: PersonPreferencePatch = {}, section: 'privacy' | 'content' = 'content') => {
    if (!current || saving.current || preview || needsRefresh) return;
    saving.current = true;
    const changes = { ...pending, ...patch };
    setPending(changes); setActiveSection(section);
    setBusy(true); setStatus(''); setFailed(false);
    try {
      const next = await responseData(browserMainApi().v1.me['person-preferences'].put({
        actingSubject: agent, ...personPreferenceCommand(current, languages, changes) },
      commandOptions()));
      setCurrent(next); setLanguages(next.contentLanguages); setPending({}); setStatus(t.personSaved);
      // Writing surfaces suggest these languages first; the next one opened reads them again.
      forgetReadingLanguages();
    } catch (error) {
      const conflict = String(error).includes('409');
      setFailed(true);
      setStatus(conflict ? t.personConflict : t.personFailed);
      if (conflict) {
        setNeedsRefresh(true);
        await reload().catch(() => setStatus(t.personRefreshFailed));
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const reviewLatest = async () => {
    if (saving.current || preview) return;
    recoveryFocus.remember();
    saving.current = true; setBusy(true);
    try { await reload(); setStatus(t.personConflict); }
    catch { setStatus(t.personRefreshFailed); }
    finally { saving.current = false; setBusy(false); }
  };
  const block = async (target: string, blocked: boolean) => {
    if (saving.current || preview || needsRefresh || failed) return;
    saving.current = true; setActiveSection('privacy'); setBusy(true); setStatus('');
    try {
      await responseData(browserMainApi().v1.me['blocked-people'].put({
        actingSubject: agent, target: target.trim(), blocked }, commandOptions()));
      await reload();
      setBlockName(''); setStatus(blocked ? t.personBlocked : t.personUnblocked);
    } catch { setStatus(t.sectionFailed); }
    finally { saving.current = false; setBusy(false); }
  };
  const draft = current ? { ...current, ...pending } : null;
  const disabled = busy || preview || needsRefresh;
  const busyMessage = needsRefresh ? t.personRefreshing : t.personSaving;
  const feedback = (section: 'privacy' | 'content') => <div id={`${feedbackId}-${section}`}
    className="grid gap-2 text-sm">
    <p role={activeSection === section && (busy || status) ? 'status' : undefined}
      aria-live="polite" aria-atomic="true">{activeSection === section ? (busy ? busyMessage : status) : ''}</p>
    {busy && activeSection !== section ? <p>{busyMessage}</p> : null}
    {failed && activeSection === section ? <Button ref={recoveryFocus.target} type="button" variant="soft" className="w-fit"
      disabled={busy || preview} onClick={() => void (needsRefresh ? reviewLatest() : save({}, section))}>
      {needsRefresh ? t.reviewLatest : t.retrySave}</Button> : null}
  </div>;
  const privacy = <div className="grid gap-4 border-t pt-5">
    <div className="grid gap-1"><h3 className="font-medium">{t.profilePrivacyTitle}</h3>
      <p className="text-muted-foreground text-sm">{t.profilePrivacyHelp}</p></div>
    {current && draft ? <>
      {feedback('privacy')}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">{t.profileVisibility}
          <ChoiceSelect label={t.profileVisibility} value={draft.profileVisibility} disabled={disabled}
            options={[{ value: 'public', label: t.libraryPublic }, { value: 'private', label: t.libraryPrivate }]}
            onValueChange={value => void save({ profileVisibility: value === 'private' ? 'private' : 'public' }, 'privacy')} />
        </label>
        <label className="grid gap-1 text-sm font-medium">{t.whoCanFollow}
          <ChoiceSelect label={t.whoCanFollow} value={draft.followPolicy} disabled={disabled}
            options={[{ value: 'everyone', label: t.followEveryone }, { value: 'nobody', label: t.followNobody }]}
            onValueChange={value => void save({ followPolicy: value === 'nobody' ? 'nobody' : 'everyone' }, 'privacy')} />
        </label>
      </div>
      <div className="flex items-center gap-3 text-sm"><Switch aria-label={t.hideReadingActivity}
        checked={draft.hideReadingActivity} disabled={disabled}
        onCheckedChange={details => void save({ hideReadingActivity: details.checked }, 'privacy')} />
        <span>{t.hideReadingActivity}</span></div>
      <div className="grid gap-2"><h3 className="font-medium">{t.blockedPeople}</h3>
        <p className="text-muted-foreground text-sm">{t.blockedPeopleHelp}</p>
        <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void block(blockName, true); }}>
          <input className="min-w-48 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
            aria-label={t.blockPerson} placeholder={t.blockPlaceholder} value={blockName} disabled={disabled || failed}
            onChange={event => setBlockName(event.target.value)} />
          <Button type="submit" disabled={disabled || failed || !blockName.trim()}>{t.blockPerson}</Button>
        </form>
        {current.blockedPeople.length ? <ul className="grid gap-2">{current.blockedPeople.map(id =>
          <li key={id} className="flex items-center justify-between gap-2 text-sm">
            <span>{t.blockedPersonId} {id.slice(-8)}</span>
            <Button type="button" variant="soft" disabled={disabled || failed}
              onClick={() => void block(id, false)}>{t.unblockPerson}</Button>
          </li>)}</ul> : <p className="text-muted-foreground text-sm">{t.noBlockedPeople}</p>}
      </div>
    </> : <p role="status" className="text-muted-foreground text-sm">{status || '…'}</p>}
  </div>;
  const content = <div className="grid gap-4 border-t pt-5">
    <div className="grid gap-1"><h3 className="font-medium">{t.contentPreferences}</h3>
      <p className="text-muted-foreground text-sm">{t.contentPreferencesHelp}</p></div>
    {current && draft ? <>
      <div role="group" aria-label={t.contentPreferences} aria-describedby={`${feedbackId}-content`}
        className="grid min-w-0 gap-4">
      <fieldset disabled={disabled} className="min-w-0" aria-label={languageT.yourLanguages}>
      <LanguagePicker t={languageT} locale={locale} suggested={suggested} value={languages}
        onChange={next => { setLanguages(next); if (!failed) setStatus(''); setActiveSection('content'); }} />
      </fieldset>
      {feedback('content')}
      {!sameLanguages(languages, current.contentLanguages) ? <p className="text-muted-foreground text-sm">{t.personUnsaved}</p> : null}
      <Button type="button" className="w-fit" disabled={disabled
        || (!failed && sameLanguages(languages, current.contentLanguages))}
        onClick={() => void save()}>{t.saveSection}</Button>
      <label className="grid gap-1 text-sm font-medium">{t.spoilerHandling}
        <ChoiceSelect label={t.spoilerHandling} value={draft.spoilerPolicy} disabled={disabled}
          options={[{ value: 'hide-unread', label: t.spoilerHideUnread },
            { value: 'show', label: t.spoilerShow }]}
          onValueChange={value => void save({ spoilerPolicy: value === 'show' ? 'show' : 'hide-unread' })} />
      </label>
      </div>
    </> : <p role="status" className="text-muted-foreground text-sm">{status || '…'}</p>}
  </div>;
  return <><Privacy agent={agent} t={t} preview={preview} extra={privacy} />
    <Reading agent={agent} t={t} preview={preview} extra={content} /></>;
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
    <NotificationSettings t={t} preview={preview} />
    {agent ? <PersonControls agent={agent} locale={locale} t={t} preview={preview}
      previewLanguages={previewLanguages} /> : null}
    <Display locale={locale} t={t} preview={preview} />
    {children}
    <Section id="account" title={t.accountTitle} help={t.accountHelp}>
      <a href={`${accountOrigin.replace(/\/$/, '')}/personal-info`} className="w-fit font-medium text-primary underline underline-offset-4">{t.accountLink}</a>
    </Section>
  </>;
}
