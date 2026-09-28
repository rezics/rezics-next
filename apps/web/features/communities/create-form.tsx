'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { RadioGroup, RadioGroupItem, RadioGroupLabel } from '@rezics/ui/radio-group';
import { Textarea } from '@rezics/ui/textarea';
import { CircleAlertIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import Link from '../shell/localized-link.tsx';
import { uploadCommunityImage } from './images.ts';
import { communityNames, type NameTranslation } from './name-fields.ts';
import { communityText as words } from './messages.ts';
import { TopicPicker, type TopicChoice } from './topics.tsx';
import { CommunityUploadField } from './upload-field.tsx';

type Rule = { key: string; title: string; body: string };
type Translation = NameTranslation & { key: string };
type Visibility = 'public' | 'restricted';

/** A multi-step command keeps its created Realm visible if a later configuration step fails. */
export function CreateCommunityForm({ actingSubject, locale }: { actingSubject: string; locale: UiLocale }) {
  const router = useRouter();
  const key = useRef<string | null>(null);
  const [name, setName] = useState('');
  const [nameLanguage, setNameLanguage] = useState<string>(locale);
  const [translations, setTranslations] = useState<Translation[]>([]);
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [topics, setTopics] = useState<TopicChoice[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [icon, setIcon] = useState<File | null>(null);
  const [banner, setBanner] = useState<File | null>(null);
  const [iconSelection, setIconSelection] = useState<string | null>(null);
  const [bannerSelection, setBannerSelection] = useState<string | null>(null);
  const [createdRealm, setCreatedRealm] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<'create' | 'handle' | 'configure' | null>(null);
  const [translationError, setTranslationError] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !name.trim() || !description.trim() || !/^[a-z][a-z0-9-]{2,29}$/.test(handle)) return;
    if (rules.some(rule => !rule.title.trim() || !rule.body.trim())) return;
    const names = communityNames(nameLanguage, name, description, translations);
    if (!names) { setTranslationError(true); return; }
    setTranslationError(false);
    setBusy(true);
    setFailure(null);
    key.current ??= crypto.randomUUID();
    const operation = key.current;
    const main = browserMainApi();
    let realm = createdRealm;
    try {
      if (!realm) {
        const { data, error } = await main.v1.spaces.post({ profile: 'space-realm-v2',
          name: name.trim(), handle, topics: topics.map(topic => topic.id), capabilities: ['realm'], actingSubject },
        { headers: { 'idempotency-key': `${operation}:create` } });
        if (!data || !('realm' in data) || !data.realm) {
          setFailure(error?.status === 409 || error?.status === 400 ? 'handle' : 'create');
          return;
        }
        realm = data.realm;
        setCreatedRealm(realm);
      }
      const id = realm.slice(-36);
      const enrolled = await main.v1.realms({ realm: id }).management.post({ actingSubject },
        { headers: { 'idempotency-key': `${operation}:management` } });
      if (!enrolled.data) throw new Error('management-enrollment-failed');
      const publishedRules = rules.map((rule, index) => ({ id: `rule-${index + 1}`,
        title: { en: rule.title.trim(), 'zh-CN': rule.title.trim() },
        body: { en: rule.body.trim(), 'zh-CN': rule.body.trim() }, governanceRule: null }));
      if (!configured) {
        const current = await main.v1.realms({ realm: id }).settings.get({ query: { actingSubject } });
        if (!current.data) throw new Error('settings-read-failed');
        const settings = { ...current.data.settings,
          visibility, reviewRequired: visibility === 'restricted',
          reviewMode: visibility === 'restricted' ? 'mandatory' as const : 'open' as const,
          whoMaySubmit: visibility === 'restricted' ? 'granted' as const : 'members' as const,
          selfJoin: visibility === 'public', rules: publishedRules };
        const updated = await main.v1.realms({ realm: id }).settings.put({ actingSubject,
          expectedGeneration: current.data.generation, expectedRulesRevision: current.data.ruleBasis.revision,
          reason: 'Set up the community', settings },
        { headers: { 'idempotency-key': `${operation}:settings` } });
        if (!updated.data) throw new Error('settings-write-failed');
        setConfigured(true);
      }
      let selectedIcon = iconSelection;
      let selectedBanner = bannerSelection;
      if (icon && !selectedIcon) {
        selectedIcon = await uploadCommunityImage({ image: icon, realm, actingSubject, kind: 'icon',
          key: `${operation}:icon` });
        setIconSelection(selectedIcon);
      }
      if (banner && !selectedBanner) {
        selectedBanner = await uploadCommunityImage({ image: banner, realm, actingSubject, kind: 'banner',
          key: `${operation}:banner` });
        setBannerSelection(selectedBanner);
      }
      const publication = { ...names,
        iconSelection: selectedIcon, bannerSelection: selectedBanner,
        replyPolicy: visibility === 'public' ? 'members-direct' as const : 'moderated' as const,
        rules: rules.map((rule, index) => ({ id: `rule-${index + 1}`,
          title: { original: names.name.original, labels: { [names.name.original]: rule.title.trim() } },
          body: { original: names.name.original, labels: { [names.name.original]: rule.body.trim() } },
          governanceRule: null })),
        count: { kind: 'exact' as const, value: null }, moderators: [] };
      const saved = await main.v1.realms({ realm: id }).profile.put({ profile: 'realm-public-profile-v2',
        expectedHead: null, actingSubject, publication },
      { headers: { 'idempotency-key': `${operation}:profile` } });
      if (!saved.data) throw new Error('profile-write-failed');
      try { localStorage.setItem(`rezics:community-setup:${actingSubject}:${realm}`,
        JSON.stringify({ topics: topics.length > 0, invite: false })); } catch { /* optional local checklist */ }
      router.push(localizedPath(`/r/${id}`, locale));
    } catch { setFailure(realm ? 'configure' : 'create'); }
    finally { setBusy(false); }
  }

  return <form className="grid max-w-2xl gap-7" onSubmit={event => void submit(event)}>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="grid gap-1.5 text-sm font-medium"><label htmlFor="community-name">{words.name[locale]}</label>
        <Input id="community-name" required maxLength={120} value={name} onChange={event => setName(event.currentTarget.value)}
          disabled={Boolean(createdRealm)} /></div>
      <div className="grid gap-1.5 text-sm font-medium"><label htmlFor="community-handle">{words.handle[locale]}</label>
        <Input id="community-handle" required pattern="[a-z][a-z0-9-]{2,29}" minLength={3} maxLength={30} value={handle}
          onChange={event => setHandle(event.currentTarget.value.toLowerCase())} disabled={Boolean(createdRealm)} />
        <span className="text-muted-foreground text-xs font-normal">{words.handleHelp[locale]}</span></div>
    </div>
    <div className="grid gap-1.5 text-sm font-medium"><label htmlFor="community-description">{words.description[locale]}</label>
      <Textarea id="community-description" required maxLength={2000} rows={3} value={description}
        onChange={event => setDescription(event.currentTarget.value)} /></div>
    <div className="grid gap-1.5 text-sm font-medium"><label htmlFor="community-name-language">{words.nameLanguage[locale]}</label>
      <Input id="community-name-language" required maxLength={35} value={nameLanguage}
        onChange={event => setNameLanguage(event.currentTarget.value)} disabled={Boolean(createdRealm)} />
      <span className="text-muted-foreground text-xs font-normal">{words.languageHelp[locale]}</span></div>
    {translations.map((translation, index) => <fieldset key={translation.key}
      className="grid gap-3 rounded-xl border border-border p-4">
      <legend className="px-1 text-sm font-semibold">{words.translation[locale]} {index + 1}</legend>
      <div className="grid gap-1.5 text-sm font-medium"><label htmlFor={`translation-language-${translation.key}`}>
        {words.translationLanguage[locale]}</label>
        <Input id={`translation-language-${translation.key}`} required maxLength={35} value={translation.language}
          onChange={event => { const value = event.currentTarget.value;
            setTranslations(before => before.map(item => item.key === translation.key
              ? { ...item, language: value } : item)); }} /></div>
      <div className="grid gap-1.5 text-sm font-medium"><label htmlFor={`translation-name-${translation.key}`}>
        {words.translationName[locale]}</label>
        <Input id={`translation-name-${translation.key}`} required maxLength={120} value={translation.name}
          onChange={event => { const value = event.currentTarget.value;
            setTranslations(before => before.map(item => item.key === translation.key
              ? { ...item, name: value } : item)); }} /></div>
      <div className="grid gap-1.5 text-sm font-medium"><label htmlFor={`translation-description-${translation.key}`}>
        {words.translationDescription[locale]}</label>
        <Textarea id={`translation-description-${translation.key}`} maxLength={2000} rows={2}
          value={translation.description} onChange={event => { const value = event.currentTarget.value;
            setTranslations(before => before.map(item =>
              item.key === translation.key ? { ...item, description: value } : item)); }} /></div>
      <Button type="button" variant="ghost" size="sm" className="justify-self-start"
        onClick={() => setTranslations(before => before.filter(item => item.key !== translation.key))}>
        <Trash2Icon aria-hidden="true" />{words.removeTranslation[locale]}</Button>
    </fieldset>)}
    {translations.length < 19 ? <Button type="button" variant="outline" size="sm" className="justify-self-start"
      onClick={() => setTranslations(before => [...before,
        { key: crypto.randomUUID(), language: '', name: '', description: '' }])}>
      <PlusIcon aria-hidden="true" />{words.addTranslation[locale]}</Button> : null}
    {translationError ? <p role="alert" className="text-destructive text-sm">{words.translationError[locale]}</p> : null}
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-semibold">{words.visibility[locale]}</legend>
      <RadioGroup value={visibility} onValueChange={details => {
        if (details.value === 'public' || details.value === 'restricted') setVisibility(details.value);
      }}>
        <RadioGroupLabel className="sr-only">{words.visibility[locale]}</RadioGroupLabel>
        {(['public', 'restricted'] as const).map(choice => <RadioGroupItem key={choice} value={choice}>
          <span className="grid gap-0.5"><span className="font-medium">{words[choice][locale]}</span>
            <span className="text-muted-foreground text-sm">{words[`${choice}Help`][locale]}</span></span>
        </RadioGroupItem>)}
      </RadioGroup>
    </fieldset>
    <fieldset className="grid gap-2">
      <legend className="text-sm font-semibold">{words.topics[locale]}</legend>
      <TopicPicker locale={locale} value={topics} onChange={setTopics} />
    </fieldset>
    <fieldset className="grid gap-3">
      <legend className="text-sm font-semibold">{words.rules[locale]}</legend>
      {rules.map((rule, index) => <div key={rule.key} className="grid gap-3 rounded-xl border border-border p-3">
        <div className="flex justify-between gap-2"><span className="font-medium text-sm">{index + 1}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRules(before => before.filter(item =>
            item.key !== rule.key))}><Trash2Icon aria-hidden="true" />{words.removeRule[locale]}</Button></div>
        <div className="grid gap-1 text-sm"><label htmlFor={`rule-title-${rule.key}`}>{words.ruleTitle[locale]}</label>
          <Input id={`rule-title-${rule.key}`} required maxLength={100} value={rule.title} onChange={event => {
            const value = event.currentTarget.value;
            setRules(before => before.map(item => item.key === rule.key ? { ...item, title: value } : item));
          }} /></div>
        <div className="grid gap-1 text-sm"><label htmlFor={`rule-body-${rule.key}`}>{words.ruleBody[locale]}</label>
          <Textarea id={`rule-body-${rule.key}`} required maxLength={1000} rows={2} value={rule.body}
            onChange={event => { const value = event.currentTarget.value;
              setRules(before => before.map(item => item.key === rule.key ? { ...item, body: value } : item)); }} />
        </div>
      </div>)}
      {rules.length < 12 ? <Button type="button" variant="outline" size="sm" className="justify-self-start"
        onClick={() => setRules(before => [...before, { key: crypto.randomUUID(), title: '', body: '' }])}>
        <PlusIcon aria-hidden="true" />{words.addRule[locale]}</Button> : null}
    </fieldset>
    <div className="grid gap-4 sm:grid-cols-2">
      <CommunityUploadField kind="icon" locale={locale} file={icon} onChange={setIcon} />
      <CommunityUploadField kind="banner" locale={locale} file={banner} onChange={setBanner} />
    </div>
    {failure ? <Alert variant="destructive" role="alert"><CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{words[failure === 'create' ? 'createFailed' : failure === 'handle' ? 'handleTaken'
        : 'configureFailed'][locale]}
        {createdRealm ? <> <Link href={`/manage/r/${createdRealm.slice(-36)}`}
          className="font-medium underline">{words.manage[locale]}</Link></> : null}</AlertDescription>
    </Alert> : null}
    <Button type="submit" isLoading={busy} className="justify-self-start">
      {busy ? words.creating[locale] : words.submitCreate[locale]}</Button>
    {createdRealm ? <Link href={`/manage/r/${createdRealm.slice(-36)}`}
      className={buttonVariants({ variant: 'outline', className: 'justify-self-start' })}>
      {words.manage[locale]}</Link> : null}
  </form>;
}
