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
import { realmHref } from '../realm/route.ts';
import { browserMainApi } from '../api/browser.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import Link from '../shell/localized-link.tsx';
import { ImageRefused, uploadCommunityImage } from './images.ts';
import { communityNames, type NameTranslation } from './name-fields.ts';
import { ruleFromText } from '../manage/rules.ts';
import { communityText as words } from './messages.ts';
import { TopicPicker, type TopicChoice } from './topics.tsx';
import { CommunityUploadField, type UploadOutcome } from './upload-field.tsx';

type Rule = { key: string; title: string; body: string };
type Translation = NameTranslation & { key: string };
type Visibility = 'public' | 'restricted';
type SpacePost = ReturnType<typeof browserMainApi>['v1']['spaces']['post'];
export type CommunityCreationIntent = Extract<Parameters<SpacePost>[0], { profile: 'space-realm-v2' }>;
type CreationResponse = Awaited<ReturnType<SpacePost>>;

export function initialCommunitySettings(visibility: Visibility,
  rules: NonNullable<CommunityCreationIntent['initialSettings']>['rules']): NonNullable<CommunityCreationIntent['initialSettings']> {
  // The form promises member-only disclosure. API "restricted" exposes public
  // headers; "private" is the API policy that fulfills this choice.
  return { visibility: visibility === 'restricted' ? 'private' : 'public',
    reviewRequired: visibility === 'restricted', reviewMode: visibility === 'restricted' ? 'mandatory' : 'open',
    whoMaySubmit: visibility === 'restricted' ? 'granted' : 'members', selfJoin: visibility === 'public', rules };
}

/** Replay the same command to read its receipt and settle pending initialization.
 * A lost response never restarts browser-side management/settings writes. */
export async function createCommunityWithReadback(input: CommunityCreationIntent, key: string,
  send: (input: CommunityCreationIntent, key: string) => Promise<CreationResponse> =
    (body, operationKey) => browserMainApi().v1.spaces.post(body,
      { headers: { 'idempotency-key': operationKey } })) {
  try {
    const result = await send(input, key);
    if (result.error?.status !== 503 && !(result.data && 'operationId' in result.data)) return result;
  } catch { /* An uncertain response is reconciled by the same creation key. */ }
  return send(input, key);
}

/** One screen follows the same bound Manage uses for this list. */
const MANAGED_REALM_PAGES = 5;

/** One Realm from `GET /v1/me/managed-realms`, with the permissions this user holds there. */
export interface ManagedRealmEntry {
  realm: string;
  permissions: readonly string[];
}

export interface FounderRealmRead {
  /** The Realm IRI at this handle when the caller can read it, or null when
   * the address is missing, unreadable or the read failed. */
  resolve(handle: string, actingSubject: string): Promise<string | null>;
  /** One page of Realms the caller manages, or null when the list failed. */
  managed(actingSubject: string, after: string | null): Promise<{
    realms: readonly ManagedRealmEntry[]; nextCursor: string | null } | null>;
}

async function resolveReadableRealm(handle: string, actingSubject: string): Promise<string | null> {
  try {
    const result = await browserMainApi().v1.addresses.resolve.get({
      query: { scope: 'space', key: handle, actingSubject } });
    const data = result.data;
    if (!data || data.status !== 'resolved' || !('capabilities' in data)) return null;
    return data.capabilities?.realm ?? null;
  } catch { return null; }
}

async function readManagedRealmPage(actingSubject: string, after: string | null) {
  try {
    const result = await browserMainApi().v1.me['managed-realms'].get({
      query: { actingSubject, ...after ? { after } : {} } });
    if (!result.data) return null;
    return { realms: result.data.items.map(item => ({ realm: item.realm, permissions: item.permissions })),
      nextCursor: result.data.nextCursor };
  } catch { return null; }
}

/** The Realm at `handle` when this founder's permissions there include `realm.owner`.
 * A Realm they only moderate or hold another permission on, someone else's Realm,
 * and a Realm they cannot read are null: the same answer as a missing address.
 * Nothing sent earlier is kept; both answers come from the API. */
export async function founderRealmAtHandle(handle: string, actingSubject: string,
  read: FounderRealmRead = { resolve: resolveReadableRealm, managed: readManagedRealmPage }): Promise<string | null> {
  const realm = await read.resolve(handle, actingSubject);
  if (!realm) return null;
  let after: string | null = null;
  for (let page = 0; page < MANAGED_REALM_PAGES; page++) {
    const listed = await read.managed(actingSubject, after);
    if (!listed) return null;
    const listedRealm = listed.realms.find(item => item.realm === realm);
    if (listedRealm) return listedRealm.permissions.includes('realm.owner') ? realm : null;
    if (!listed.nextCursor) return null;
    after = listed.nextCursor;
  }
  return null;
}

/** What the creation response asks the form to do. A receipt, including a
 * same-page replay of the held key, is the only step that writes. An owned
 * Realm is named so the form can link to it. Every other answer writes nothing. */
export async function stepAfterCreation(
  response: { data: CreationResponse['data']; error: CreationResponse['error'] },
  handle: string, actingSubject: string,
  read: FounderRealmRead = { resolve: resolveReadableRealm, managed: readManagedRealmPage },
): Promise<{ step: 'write'; realm: string } | { step: 'owned'; realm: string } | { step: 'taken' } | { step: 'keep' }> {
  const data = response.data;
  if (data && 'realm' in data && data.realm) return { step: 'write', realm: data.realm };
  const code = problemCode(response.error);
  if (code === 'alias_conflict') {
    const owned = await founderRealmAtHandle(handle, actingSubject, read);
    return owned ? { step: 'owned', realm: owned } : { step: 'taken' };
  }
  if (code === 'invalid_alias') return { step: 'taken' };
  return { step: 'keep' };
}

/** The notice and the address that opens a community this founder already owns. */
export function ownedRealmNotice(realm: string, locale: UiLocale): { notice: string; href: string } {
  return { notice: words.alreadyYours[locale], href: realmHref(locale, realm.slice(-36)) };
}

function OwnedCommunityNotice({ locale, realm }: { locale: UiLocale; realm: string }) {
  const { notice, href } = ownedRealmNotice(realm, locale);
  return <Alert variant="info" role="alert">
    <AlertDescription>{notice}{' '}
      <Link href={href} className="font-medium underline">{words.openYours[locale]}</Link>
    </AlertDescription>
  </Alert>;
}

/** A private Realm has no public profile to publish, and a profile that
 * already has a head is already saved. Either answer still opens the Realm. */
export function profilePublicationOpensRealm(code: string | null): boolean {
  return code === 'stale_realm_profile' || code === 'realm_unavailable';
}

function problemCode(error: { value?: unknown } | null | undefined): string | null {
  const value = error?.value;
  return value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
    ? value.code : null;
}

/** Disclosure, admission and rules are one server-owned creation operation. */
export function CreateCommunityForm({ actingSubject, locale }: { actingSubject: string; locale: UiLocale }) {
  const router = useRouter();
  const key = useRef<string | null>(null);
  const creationIntent = useRef<CommunityCreationIntent | null>(null);
  const [name, setName] = useState('');
  // The language the writer chose for the name, description and rules; never the interface locale.
  const [chosenLanguage, setChosenLanguage] = useState<string | null>(null);
  const reading = useReadingLanguages(actingSubject);
  const nameLanguage = writingLanguage({ chosen: chosenLanguage, reading });
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
  const [ownedRealm, setOwnedRealm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<'create' | 'handle' | 'configure' | null>(null);
  const [translationError, setTranslationError] = useState(false);
  // What screening said about each image, or that its upload budget is spent.
  const [outcomes, setOutcomes] = useState<Record<'icon' | 'banner', UploadOutcome>>({ icon: null, banner: null });
  const outcome = (kind: 'icon' | 'banner', value: UploadOutcome) => setOutcomes(before => ({ ...before, [kind]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !name.trim() || !description.trim() || !/^[a-z][a-z0-9-]{2,29}$/.test(handle)) return;
    if (rules.some(rule => !rule.title.trim() || !rule.body.trim())) return;
    const names = communityNames(nameLanguage, name, description, translations);
    if (!names) { setTranslationError(true); return; }
    setTranslationError(false);
    setBusy(true);
    setFailure(null);
    setOwnedRealm(null);
    key.current ??= crypto.randomUUID();
    const operation = key.current;
    const main = browserMainApi();
    const publishedRules = rules.map((rule, index) =>
      ruleFromText(`rule-${index + 1}`, rule.title.trim(), rule.body.trim(), nameLanguage));
    let realm = createdRealm;
    let uploading: 'icon' | 'banner' = 'icon';
    try {
      if (!realm) {
        creationIntent.current ??= { profile: 'space-realm-v2', language: nameLanguage,
          name: name.trim(), handle, topics: topics.map(topic => topic.id), capabilities: ['realm'], actingSubject,
          initialSettings: initialCommunitySettings(visibility, publishedRules) };
        const response = await createCommunityWithReadback(creationIntent.current, `${operation}:create`);
        const step = await stepAfterCreation(response, handle, actingSubject);
        // A Realm this founder owns is only linked. The form cannot tell a lost
        // submission from an older Realm, so it never writes over either one.
        if (step.step === 'owned') {
          setOwnedRealm(step.realm);
          return;
        }
        if (step.step === 'taken') {
          // A refused alias has no Realm to open. A corrected address is a new
          // command; uncertain outcomes retain their original intent.
          creationIntent.current = null;
          key.current = null;
          setFailure('handle');
          return;
        }
        if (step.step === 'keep') {
          setFailure('create');
          return;
        }
        realm = step.realm;
        setCreatedRealm(realm);
      }
      const id = realm.slice(-36);
      let selectedIcon = iconSelection;
      let selectedBanner = bannerSelection;
      if (icon && !selectedIcon) {
        uploading = 'icon';
        selectedIcon = await uploadCommunityImage({ image: icon, realm, actingSubject, kind: 'icon',
          key: `${operation}:icon`, onClearance: clearance => outcome('icon', { clearance }) });
        setIconSelection(selectedIcon);
      }
      if (banner && !selectedBanner) {
        uploading = 'banner';
        selectedBanner = await uploadCommunityImage({ image: banner, realm, actingSubject, kind: 'banner',
          key: `${operation}:banner`, onClearance: clearance => outcome('banner', { clearance }) });
        setBannerSelection(selectedBanner);
      }
      const publication = { ...names,
        iconSelection: selectedIcon, bannerSelection: selectedBanner,
        replyPolicy: visibility === 'public' ? 'members-direct' as const : 'moderated' as const,
        rules: creationIntent.current?.initialSettings?.rules ?? publishedRules,
        count: { kind: 'exact' as const, value: null }, moderators: [] };
      const saved = await main.v1.realms({ realm: id }).profile.put({ profile: 'realm-public-profile-v2',
        expectedHead: null, actingSubject, publication },
      { headers: { 'idempotency-key': `${operation}:profile` } });
      if (!saved.data && !profilePublicationOpensRealm(problemCode(saved.error))) throw new Error('profile-write-failed');
      try { localStorage.setItem(`rezics:community-setup:${actingSubject}:${realm}`,
        JSON.stringify({ topics: topics.length > 0, invite: false })); } catch { /* optional local checklist */ }
      router.push(realmHref(locale, id));
    } catch (error) {
      if (error instanceof ImageRefused && error.reason === 'limited') {
        outcome(uploading, { limited: error.retryAfter ?? 60 });
      }
      setFailure(realm ? 'configure' : 'create');
    }
    finally { setBusy(false); }
  }

  return <form className="grid max-w-2xl gap-7" onSubmit={event => void submit(event)}>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="grid gap-1.5 text-sm font-medium"><label htmlFor="community-name">{words.name[locale]}</label>
        <Input id="community-name" required maxLength={120} value={name} {...textAttributes(nameLanguage, name)} onChange={event => setName(event.currentTarget.value)}
          disabled={Boolean(creationIntent.current)} /></div>
      <div className="grid gap-1.5 text-sm font-medium"><label htmlFor="community-handle">{words.handle[locale]}</label>
        <Input id="community-handle" required pattern="[a-z][a-z0-9-]{2,29}" minLength={3} maxLength={30} value={handle}
          onChange={event => setHandle(event.currentTarget.value.toLowerCase())} disabled={Boolean(creationIntent.current)} />
        <span className="text-muted-foreground text-xs font-normal">{words.handleHelp[locale]}</span></div>
    </div>
    <div className="grid gap-1.5 text-sm font-medium"><label htmlFor="community-description">{words.description[locale]}</label>
      <Textarea id="community-description" required maxLength={2000} rows={3} value={description}
        {...textAttributes(nameLanguage, description)}
        onChange={event => setDescription(event.currentTarget.value)} /></div>
    <div className="grid justify-items-start gap-1.5 text-sm font-medium">
      <label htmlFor="community-name-language">{words.nameLanguage[locale]}</label>
      <LanguageSelect id="community-name-language" value={nameLanguage} onChange={setChosenLanguage} locale={locale}
        reading={reading} label={words.nameLanguage[locale]} disabled={Boolean(creationIntent.current)} />
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
    <fieldset className="grid gap-2" disabled={Boolean(creationIntent.current)}>
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
    <fieldset className="grid gap-2" disabled={Boolean(creationIntent.current)}>
      <legend className="text-sm font-semibold">{words.topics[locale]}</legend>
      <TopicPicker locale={locale} value={topics} onChange={setTopics} />
    </fieldset>
    <fieldset className="grid gap-3" disabled={Boolean(creationIntent.current)}>
      <legend className="text-sm font-semibold">{words.rules[locale]}</legend>
      {rules.map((rule, index) => <div key={rule.key} className="grid gap-3 rounded-xl border border-border p-3">
        <div className="flex justify-between gap-2"><span className="font-medium text-sm">{index + 1}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRules(before => before.filter(item =>
            item.key !== rule.key))}><Trash2Icon aria-hidden="true" />{words.removeRule[locale]}</Button></div>
        <div className="grid gap-1 text-sm"><label htmlFor={`rule-title-${rule.key}`}>{words.ruleTitle[locale]}</label>
          <Input id={`rule-title-${rule.key}`} required maxLength={100} value={rule.title}
            {...textAttributes(nameLanguage, rule.title)} onChange={event => {
            const value = event.currentTarget.value;
            setRules(before => before.map(item => item.key === rule.key ? { ...item, title: value } : item));
          }} /></div>
        <div className="grid gap-1 text-sm"><label htmlFor={`rule-body-${rule.key}`}>{words.ruleBody[locale]}</label>
          <Textarea id={`rule-body-${rule.key}`} required maxLength={1000} rows={2} value={rule.body}
            {...textAttributes(nameLanguage, rule.body)}
            onChange={event => { const value = event.currentTarget.value;
              setRules(before => before.map(item => item.key === rule.key ? { ...item, body: value } : item)); }} />
        </div>
      </div>)}
      {rules.length < 12 ? <Button type="button" variant="outline" size="sm" className="justify-self-start"
        onClick={() => setRules(before => [...before, { key: crypto.randomUUID(), title: '', body: '' }])}>
        <PlusIcon aria-hidden="true" />{words.addRule[locale]}</Button> : null}
    </fieldset>
    <div className="grid gap-4 sm:grid-cols-2">
      <CommunityUploadField kind="icon" locale={locale} file={icon} onChange={setIcon} outcome={outcomes.icon} />
      <CommunityUploadField kind="banner" locale={locale} file={banner} onChange={setBanner} outcome={outcomes.banner} />
    </div>
    {failure ? <Alert variant="destructive" role="alert"><CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{words[failure === 'create' ? 'createFailed' : failure === 'handle' ? 'handleTaken'
        : 'configureFailed'][locale]}
        {createdRealm ? <> <Link href={`/manage/r/${createdRealm.slice(-36)}`}
          className="font-medium underline">{words.manage[locale]}</Link></> : null}</AlertDescription>
    </Alert> : null}
    {ownedRealm ? <OwnedCommunityNotice locale={locale} realm={ownedRealm} /> : null}
    <Button type="submit" isLoading={busy} className="justify-self-start">
      {busy ? words.creating[locale] : words.submitCreate[locale]}</Button>
    {createdRealm ? <Link href={`/manage/r/${createdRealm.slice(-36)}`}
      className={buttonVariants({ variant: 'outline', className: 'justify-self-start' })}>
      {words.manage[locale]}</Link> : null}
  </form>;
}
