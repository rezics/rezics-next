'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Field, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { NativeSelect } from '@rezics/ui/native-select';
import { CircleCheckIcon, HourglassIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import Link from '../shell/localized-link.tsx';
import { type AliasSaver, saveAlias } from './alias.ts';
import { attributeOf, attributesOf, type Candidate, canCreate, type CreateAnswer, destinationOf, type Grain, guessLanguage,
  idOf, type HeaderMark, type IntakePort, mainIntake, type OwnerAnswer, type SearchInput, searchable, type SearchState }
  from './intake.ts';
import { type Copy, copyOf } from './messages.ts';
import { ProvisionalNotice } from './provisional-notice.tsx';

/** The languages offered for what was typed; the list is a convenience, not a limit Main imposes. */
export const inputLanguages = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'de', 'fr', 'es'] as const;

function languageName(tag: string, locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/** What the record is, as the contributor names it. Each kind says which grain Main is asked about, never what Main must do. */
const kinds = [
  { kind: 'story', label: 'kindStory', help: 'kindStoryHelp', needsParent: false },
  { kind: 'translation', label: 'kindTranslation', help: 'kindTranslationHelp', needsParent: true },
  { kind: 'publication', label: 'kindPublication', help: 'kindPublicationHelp', needsParent: true },
  { kind: 'part', label: 'kindPart', help: 'kindPartHelp', needsParent: true },
  { kind: 'collection', label: 'kindCollection', help: 'kindCollectionHelp', needsParent: false },
] as const;
type Kind = (typeof kinds)[number]['kind'];

/** The grain Main is asked about for kinds that are written through another owner API. */
const grainOf: Partial<Record<Kind, Grain>> = { translation: 'translation-or-version', publication: 'publication',
  collection: 'collection' };

export interface TypeChoice { type: string; label: string }

type Step =
  | { name: 'search' }
  | { name: 'kind' }
  | { name: 'created'; work: string; parent: Candidate | null; provenance: HeaderMark['provenance'];
    verification: 'unverified' | 'verified' | null };

/** The notice a step shows after something went wrong or needs saying; `tone` picks the alert. */
type Notice = { tone: 'error' | 'info'; title?: string; body: string } | null;

const retryDelays = [0, 600, 1500];

/** Wait text for Retry-After, in the reader's language. */
function waitText(seconds: number, locale: UiLocale): string {
  try { return new Intl.NumberFormat(locale, { style: 'unit', unit: 'second', unitDisplay: 'long' }).format(seconds); }
  catch { return `${seconds}s`; }
}

function Results({ candidates, t, busy, onTranslate, onAlias, onCreate, canStartCreate }: {
  candidates: readonly Candidate[]; t: Copy; busy: string | null;
  onTranslate: (candidate: Candidate) => void; onAlias: (candidate: Candidate) => void; onCreate: () => void;
  canStartCreate: boolean;
}) {
  return <section aria-labelledby="intake-results" className="grid gap-4">
    <div className="grid gap-1">
      <h2 id="intake-results" className="font-semibold text-xl">{t.resultsHeading}</h2>
      <p role="status" data-testid="intake-count" className="text-muted-foreground text-sm">
        {candidates.length ? t.found(candidates.length) : t.none}</p>
    </div>
    {candidates.length ? <ul aria-label={t.resultsHeading} className="grid gap-3">
      {candidates.map(candidate => {
        const title = attributeOf(candidate, 'title');
        const aliases = attributesOf(candidate, 'alias').filter(alias => alias.value !== title?.value);
        const creators = attributesOf(candidate, 'creator').map(creator => creator.value);
        const unverified = attributeOf(candidate, 'verification')?.value === 'unverified';
        const id = idOf(candidate.work);
        return <li key={candidate.work} data-candidate={id} className="grid gap-3 rounded-2xl border border-border/70
          bg-card p-4">
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 lang={title?.language ?? undefined} className="min-w-0 break-words font-medium font-work-title
                text-lg">{title?.value ?? id}</h3>
              {unverified ? <Badge variant="warning" title={t.unverifiedHelp}>{t.unverified}</Badge> : null}
            </div>
            {creators.length ? <p className="text-muted-foreground text-sm">{t.by({ creators: creators.join(', ') })}</p> : null}
            {aliases.length ? <p className="text-muted-foreground text-sm">{t.matchedAs}{': '}
              {aliases.map((alias, index) => <span key={`${alias.value}:${alias.language}`}>
                {index ? ' · ' : ''}<span lang={alias.language ?? undefined}>{alias.value}</span></span>)}</p> : null}
          </div>
          <div role="group" aria-label={t.candidateActions({ title: title?.value ?? id })} className="flex flex-wrap gap-2">
            <Link href={`/w/${id}`} className={buttonVariants({ size: 'sm' })}>{t.useExisting}</Link>
            <Button type="button" variant="outline" size="sm" onClick={() => onAlias(candidate)}>{t.addAlias}</Button>
            <Button type="button" variant="outline" size="sm" isLoading={busy === candidate.work}
              disabled={busy !== null} onClick={() => onTranslate(candidate)}>{t.addTranslation}</Button>
            <Link href={`/w/${id}/edit/parts`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t.addPart}</Link>
          </div>
        </li>;
      })}
    </ul> : null}
    <p className="max-w-2xl text-muted-foreground text-xs">{t.sampled}</p>
    {canStartCreate ? <div data-testid="intake-create" className="flex flex-wrap items-center gap-3 border-border/60
      border-t pt-4">
      <p className="font-medium text-sm">{t.createPrompt}</p>
      <Button type="button" variant="outline" onClick={onCreate}>{t.createButton}</Button>
    </div> : null}
  </section>;
}

function AliasForm({ candidate, t, locale, actingSubject, save, onClose }: {
  candidate: Candidate; t: Copy; locale: UiLocale; actingSubject: string; save: AliasSaver; onClose: () => void;
}) {
  const [alias, setAlias] = useState('');
  const [language, setLanguage] = useState<string>(guessLanguage('', locale));
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'denied' | 'taken' | 'invalid' | 'failed'>('idle');
  const title = attributeOf(candidate, 'title')?.value ?? idOf(candidate.work);
  const message = { saved: t.aliasSaved, denied: t.aliasDenied, taken: t.aliasTaken, invalid: t.aliasInvalid,
    failed: t.aliasFailed } as const;
  return <form aria-label={t.aliasHeading({ title })} className="grid gap-4 rounded-2xl border border-border/70 bg-card p-4"
    onSubmit={async event => {
      event.preventDefault();
      setState('saving');
      setState(await save({ actingSubject, work: candidate.work, alias, language }));
    }}>
    <h2 className="font-semibold text-lg">{t.aliasHeading({ title })}</h2>
    <Field><FieldLabel>{t.aliasLabel}</FieldLabel>
      <Input value={alias} onChange={event => setAlias(event.currentTarget.value)} maxLength={500} required
        autoComplete="off" /></Field>
    <Field><FieldLabel>{t.aliasLanguage}</FieldLabel>
      <NativeSelect value={language} onChange={event => setLanguage(event.currentTarget.value)} size="md">
        {inputLanguages.map(tag => <option key={tag} value={tag}>{languageName(tag, locale)}</option>)}
      </NativeSelect></Field>
    {state !== 'idle' && state !== 'saving' ? <Alert variant={state === 'saved' ? 'success' : 'destructive'} role="status">
      {state === 'saved' ? <CircleCheckIcon aria-hidden="true" /> : <TriangleAlertIcon aria-hidden="true" />}
      <AlertDescription>{message[state]}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" isLoading={state === 'saving'} disabled={state === 'saving' || state === 'saved'}>
        {state === 'saving' ? t.aliasSaving : t.aliasSave}</Button>
      <Button type="button" variant="ghost" onClick={onClose}>{t.cancel}</Button>
    </div>
  </form>;
}

/**
 * Adds a book, volume, translation or edition without making a duplicate. Step one searches Main's
 * candidates as the contributor types and offers what to do with each; only after a search for
 * exactly what is typed has returned does it offer to create. Step two, for "create", asks what
 * the record is, then asks Main where it goes. The grain choices and routing are Main's answers.
 */
export function IntakeWizard({ actingSubject, locale, port, types = [], saveAliasTo = saveAlias, debounceMs = 300, initialText = '' }: {
  actingSubject: string; locale: UiLocale;
  /** Main's search and write calls; stories and tests supply their own. */
  port?: IntakePort;
  /** The kinds of work the registry lets a contributor create. */
  types?: readonly TypeChoice[];
  saveAliasTo?: AliasSaver; debounceMs?: number; initialText?: string;
}) {
  const t = copyOf(locale);
  const router = useRouter();
  const intake = useRef(port ?? mainIntake()).current;
  const [text, setText] = useState(initialText);
  const [creator, setCreator] = useState('');
  const [language, setLanguage] = useState<string>((inputLanguages as readonly string[]).includes(locale) ? locale : 'en');
  const [languageTouched, setLanguageTouched] = useState(false);
  const [search, setSearch] = useState<SearchState>({ phase: 'idle' });
  const [step, setStep] = useState<Step>({ name: 'search' });
  const [aliasFor, setAliasFor] = useState<Candidate | null>(null);
  const [kind, setKind] = useState<Kind>('story');
  const [parent, setParent] = useState<string>('');
  const [semanticType, setSemanticType] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const asked = useRef(0);
  const input: SearchInput = { text, language, creator };

  // Search as the contributor types: the answer applies only to the input it was asked for.
  useEffect(() => {
    const request = ++asked.current;
    if (!searchable(text)) { setSearch({ phase: 'idle' }); return; }
    const current: SearchInput = { text, language, creator };
    const timer = setTimeout(() => {
      setSearch({ phase: 'searching', input: current });
      intake.search(current).then(answer => { if (request === asked.current) setSearch(answer); },
        () => { if (request === asked.current) setSearch({ phase: 'failed', input: current, reason: 'unavailable' }); });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [text, language, creator, intake, debounceMs]);

  const found = search.phase === 'found' ? search : null;
  const reachable = canCreate(search, input);

  function retrySearch() {
    // The same text again is a new search with a new receipt.
    setText(value => `${value} `);
    setTimeout(() => setText(value => value.trimEnd()), 0);
  }

  function type(value: string) {
    setText(value);
    setNotice(null);
    if (!languageTouched) setLanguage(guessLanguage(value, language));
  }

  async function routeTo(grain: Grain, destinationWork: Candidate | null) {
    if (!found) return;
    setNotice(null);
    setBusy(destinationWork?.work ?? grain);
    const answer: OwnerAnswer = await intake.ownerApi(grain, input, found.receipt, actingSubject);
    if (answer.outcome !== 'owner-api') {
      setBusy(null);
      setNotice({ tone: 'error', body: answer.outcome === 'denied' ? t.routeDenied : t.routeUnavailable });
      return;
    }
    const to = destinationWork ? destinationOf(answer.path, destinationWork.work) : null;
    if (to) { setNotice({ tone: 'info', body: t.routing }); router.push(localizedPath(to, locale)); return; }
    setBusy(null);
    setNotice({ tone: 'info', title: t.routedTo({ api: `${answer.method} ${answer.path}` }), body: t.routeMissing });
  }

  async function create() {
    if (!found || !reachable) return;
    setNotice(null);
    setBusy('create');
    const answer: CreateAnswer = await intake.create(found.input, found.receipt, actingSubject, semanticType || null);
    setBusy(null);
    switch (answer.outcome) {
      case 'created': {
        const series = kind === 'part' ? found.candidates.find(candidate => candidate.work === parent) ?? null : null;
        setStep({ name: 'created', work: answer.work, parent: series, provenance: null, verification: 'unverified' });
        for (const delay of retryDelays) {
          await new Promise(done => setTimeout(done, delay));
          const read = await intake.provenance(answer.work);
          if (read?.provenance || read?.verification) {
            setStep(current => current.name === 'created'
              ? { ...current, provenance: read.provenance, verification: read.verification } : current);
            break;
          }
        }
        return;
      }
      case 'pending': setNotice({ tone: 'info', body: t.createPending }); return;
      case 'limit': setNotice({ tone: 'error', title: t.limitTitle, body: `${t.limitBody} ${answer.retryAfter
        ? t.limitRetry({ wait: waitText(answer.retryAfter, locale) }) : t.limitRetryUnknown}` }); return;
      case 'search-again': setStep({ name: 'search' }); setNotice({ tone: 'info', body: t.searchAgain }); retrySearch(); return;
      case 'denied': setNotice({ tone: 'error', body: t.createDenied }); return;
      case 'unavailable': setNotice({ tone: 'error', body: t.createUnavailable }); return;
    }
  }

  const alert = notice ? <Alert variant={notice.tone === 'error' ? 'destructive' : 'info'}
    role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="intake-notice">
    {notice.tone === 'error' ? <TriangleAlertIcon aria-hidden="true" /> : <HourglassIcon aria-hidden="true" />}
    {notice.title ? <AlertTitle>{notice.title}</AlertTitle> : null}
    <AlertDescription>{notice.body}</AlertDescription></Alert> : null;

  if (step.name === 'created') {
    return <section aria-labelledby="intake-created" className="grid gap-5">
      <Alert variant="success" role="status"><CircleCheckIcon aria-hidden="true" />
        <AlertTitle id="intake-created">{t.createdHeading}</AlertTitle>
        <AlertDescription>{t.createdBody}</AlertDescription></Alert>
      <ProvisionalNotice verification={step.verification} provenance={step.provenance} locale={locale} />
      <div className="flex flex-wrap gap-2">
        <Link href={`/w/${idOf(step.work)}`} className={buttonVariants()}>{t.openRecord}</Link>
        {step.parent ? <Link href={`/w/${idOf(step.parent.work)}/edit/parts`}
          className={buttonVariants({ variant: 'outline' })}>
          {t.addToSeries({ series: attributeOf(step.parent, 'title')?.value ?? idOf(step.parent.work) })}</Link> : null}
        <Button type="button" variant="ghost" onClick={() => { setStep({ name: 'search' }); setText(''); setNotice(null); setKind('story'); }}>
          {t.addAnother}</Button>
      </div>
    </section>;
  }

  if (step.name === 'kind' && found) {
    const choice = kinds.find(item => item.kind === kind)!;
    const needsParent = choice.needsParent;
    const grain = grainOf[kind];
    const parentCandidate = found.candidates.find(candidate => candidate.work === parent) ?? null;
    return <form aria-label={t.stepTwoHeading} className="grid gap-6" onSubmit={event => {
      event.preventDefault();
      if (needsParent && !parentCandidate) return;
      if (grain) void routeTo(grain, parentCandidate); else void create();
    }}>
      <div className="grid gap-2">
        <h2 className="font-semibold text-2xl tracking-tight">{t.stepTwoHeading}</h2>
        <p className="text-muted-foreground text-sm">{t.stepTwoIntro({ title: found.input.text.trim() })}</p>
      </div>
      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-2 font-medium text-sm">{t.kindLegend}</legend>
        {kinds.map(item => <label key={item.kind} className="flex cursor-pointer items-start gap-3 rounded-2xl border
          border-border p-3 hover:bg-accent/60 has-checked:border-primary has-checked:bg-primary/5
          has-focus-visible:ring-[3px] has-focus-visible:ring-ring/32">
          <input type="radio" name="kind" value={item.kind} checked={kind === item.kind} className="mt-1"
            onChange={() => { setKind(item.kind); setParent(''); setNotice(null); }} />
          <span className="grid gap-0.5"><span className="font-medium text-sm">{t[item.label]}</span>
            <span className="text-muted-foreground text-xs">{t[item.help]}</span></span>
        </label>)}
      </fieldset>
      {needsParent ? <fieldset className="grid min-w-0 gap-2" data-testid="intake-parent">
        <legend className="mb-2 font-medium text-sm">{kind === 'part' ? t.parentLegendPart : t.parentLegend}</legend>
        {found.candidates.length ? found.candidates.map(candidate => {
          const title = attributeOf(candidate, 'title');
          return <label key={candidate.work} className="flex cursor-pointer items-start gap-3 rounded-xl border
            border-border p-3 hover:bg-accent/60 has-checked:border-primary has-checked:bg-primary/5">
            <input type="radio" name="parent" value={candidate.work} checked={parent === candidate.work} className="mt-1"
              onChange={() => setParent(candidate.work)} />
            <span lang={title?.language ?? undefined} className="text-sm">{title?.value ?? idOf(candidate.work)}</span>
          </label>;
        }) : <p className="text-muted-foreground text-sm">{t.parentNone}</p>}
      </fieldset> : null}
      {kind === 'story' || kind === 'part' ? types.length ? <Field>
        <FieldLabel>{t.typeLabel}</FieldLabel>
        <NativeSelect value={semanticType} onChange={event => setSemanticType(event.currentTarget.value)} className="sm:max-w-72">
          <option value="">{t.typeNone}</option>
          {types.map(choice => <option key={choice.type} value={choice.type}>{choice.label}</option>)}
        </NativeSelect></Field> : null : null}
      {alert}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" isLoading={busy !== null} disabled={busy !== null || (needsParent && !parentCandidate)}>
          {grain ? t.continue : busy === 'create' ? t.creating : t.createRecord}</Button>
        <Button type="button" variant="ghost" size="lg" onClick={() => { setStep({ name: 'search' }); setNotice(null); }}>
          {t.back}</Button>
      </div>
    </form>;
  }

  const failure = search.phase === 'failed' ? { unavailable: t.searchUnavailable, 'signed-out': t.searchSignedOut,
    invalid: t.searchInvalid }[search.reason] : null;
  return <div className="grid gap-8">
    <form role="search" aria-label={t.searchLegend} className="grid gap-5" onSubmit={event => event.preventDefault()}>
      <Field>
        <FieldLabel>{t.searchLabel}</FieldLabel>
        <div className="relative">
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2
            text-muted-foreground" />
          <Input name="q" type="search" size="lg" value={text} onChange={event => type(event.currentTarget.value)}
            maxLength={500} autoComplete="off" spellCheck={false} className="ps-9 font-work-title" />
        </div>
        <FieldHelper>{t.searchHelp}</FieldHelper>
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field>
          <FieldLabel>{t.languageLabel}</FieldLabel>
          <NativeSelect name="language" value={language} className="w-full"
            onChange={event => { setLanguage(event.currentTarget.value); setLanguageTouched(true); }}>
            {inputLanguages.map(tag => <option key={tag} value={tag}>{languageName(tag, locale)}</option>)}
            <option value="und">{t.languageUndetermined}</option>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel>{t.creatorLabel}</FieldLabel>
          <Input name="creator" value={creator} onChange={event => setCreator(event.currentTarget.value)}
            maxLength={500} autoComplete="off" />
          <FieldHelper>{t.creatorHelp}</FieldHelper>
        </Field>
      </div>
    </form>
    {alert}
    {aliasFor ? <AliasForm candidate={aliasFor} t={t} locale={locale} actingSubject={actingSubject} save={saveAliasTo}
      onClose={() => setAliasFor(null)} /> : null}
    <div aria-busy={search.phase === 'searching'} className="grid gap-4">
      {search.phase === 'searching' ? <p role="status" className="text-muted-foreground text-sm">{t.searching}</p> : null}
      {failure ? <Alert variant="destructive" role="alert"><TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>{t.searchFailed}</AlertTitle><AlertDescription className="grid gap-2"><span>{failure}</span>
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={retrySearch}>{t.searchRetry}</Button>
        </AlertDescription></Alert> : null}
      {found && reachable ? <Results candidates={found.candidates} t={t}
        busy={busy} canStartCreate={reachable}
        onAlias={candidate => { setAliasFor(candidate); setNotice(null); }}
        onTranslate={candidate => void routeTo('translation-or-version', candidate)}
        onCreate={() => { setStep({ name: 'kind' }); setNotice(null); }} /> : null}
    </div>
  </div>;
}
