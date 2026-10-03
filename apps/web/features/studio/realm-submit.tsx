'use client';

import { RadioGroup, RadioGroupItem } from '@rezics/ui/radio-group';
import { EntityPicker, type EntityPickerItem, type EntityPickerLoad, type EntityPickerSelection } from '@rezics/ui/entity-picker';
import { browserMainApi } from '../api/browser.ts';
import { browseTypeCondition, discoveryApi } from '../discover/api.ts';
import { browseMessages } from '../discover/browse-messages.ts';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { CircleCheckIcon, GavelIcon, InfoIcon, TriangleAlertIcon, UsersIcon, ZapIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import Link from '../shell/localized-link.tsx';
import type { StudioMessages } from './messages.ts';
import { workHref } from './agent.ts';
import { languageName, reviewModeText } from './parts.tsx';
import type { RealmOption } from './read.ts';
import { submitToRealm } from './text-api.ts';
import type { Loaded, MainClient, NativeVariants, ReviewMode } from './types.ts';

type T = ContractOf<StudioMessages>;
type Candidate = NativeVariants['variants'][number];

export interface RealmSubmitProps {
  agent: AgentOption;
  work: { id: string; mainVersion: string; book: boolean };
  /** The Work's public texts by this Agent; a Realm reviews one of them. */
  texts: Loaded<Candidate[]>;
  realms: Loaded<RealmOption[]>;
  /** Realms already reviewing this Work, so a second submission is not offered. */
  open: readonly string[];
  locale: UiLocale;
  messages: StudioMessages;
  /** Stories pass a stand-in Main; the app uses the browser client through the BFF. */
  main?: MainClient;
  loadRealms?: EntityPickerLoad<RealmPickerItem>;
}
export interface RealmPickerItem extends EntityPickerItem { realm: RealmOption }

function ModeIcon({ mode }: { mode: ReviewMode | null }) {
  const Icon = mode === 'open' ? ZapIcon : mode === 'trusted-members' ? UsersIcon : GavelIcon;
  return <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

function outcomeText(outcome: string, state: string | undefined, realm: string, t: T): { ok: boolean; text: string } {
  if (outcome === 'done') return { ok: true, text: state === 'accepted' ? t.submitAccepted({ realm })
    : t.submitDone({ realm }) };
  if (outcome === 'denied') return { ok: false, text: t.submitDenied };
  if (outcome === 'stale') return { ok: false, text: t.submitStale };
  return { ok: false, text: outcome === 'pending' ? t.submitPending : t.submitFailed };
}

/**
 * Submitting the Work to one Realm at a time: which published text the Realm
 * reviews, and for each Realm what happens next (its moderators decide, its
 * trusted members are accepted at once, or anyone is). Each submission is its
 * own command, and Main's answer is said as it is.
 */
export function RealmSubmit({ agent, work, texts, realms, open, locale, messages, main, loadRealms }: RealmSubmitProps) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const candidates = texts.ok ? texts.data : [];
  const [text, setText] = useState(candidates[0]?.contribution ?? '');
  const [selection, setSelection] = useState<EntityPickerSelection<RealmPickerItem>[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const keys = useRef<Record<string, string>>({});
  const realm = selection[0]?.item.realm;
  const load: EntityPickerLoad<RealmPickerItem> = loadRealms ?? (async ({ q, cursor }) => {
    const page = await discoveryApi(main ?? browserMainApi(), locale).resources({ profile: 'resource-list-v1',
      context: 'global', scope: { kind: 'all' }, sort: q ? 'relevance' : 'newest', limit: 20,
      ...(q ? { q } : {}), ...(cursor ? { cursor } : {}),
      filter: { all: [browseTypeCondition('communities')] } });
    return { ...page, items: page.items.map(item => ({ value: item.id, label: item.name.value,
      disabled: open.includes(item.id), realm: realms.ok && realms.data.find(option => option.id === item.id)
        || { id: item.id, name: item.name, reviewMode: null } })) };
  });

  if (!candidates.length) {
    return <div className="grid justify-items-start gap-3 rounded-2xl border border-border/80 border-dashed p-5">
      <p className="flex items-start gap-2 text-sm"><InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info-foreground" />
        {!texts.ok ? t.publishedTextsFailed : work.book ? t.submitNeedsIntroduction : t.submitNeedsText}</p>
      <Link href={workHref(agent, work.id, 'text')} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {work.book ? t.introduction : t.texts}</Link>
    </div>;
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const chosen = realm;
    const candidate = candidates.find(item => item.contribution === text);
    if (!chosen || !candidate) return;
    setBusy(true);
    setResult(null);
    // One key per Realm and text: a retry after a lost answer replays instead of submitting twice.
    const key = keys.current[`${chosen.id}\0${text}`] ??= crypto.randomUUID();
    const answer = await submitToRealm({ actingSubject: agent.iri, realm: chosen.id, work: work.id,
      mainVersion: work.mainVersion, text: candidate.contribution, publication: {
        publicationDecision: candidate.publicationDecision, selectedDraft: candidate.selectedDraft }, key }, main)
      .catch(() => ({ outcome: 'failed' as const, state: undefined }));
    setBusy(false);
    setResult(outcomeText(answer.outcome, answer.state, chosen.name.value, t));
    if (answer.outcome === 'done') router.refresh();
  };
  return <form onSubmit={event => void submit(event)} className="grid gap-5">
    {candidates.length > 1 ? <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-1 font-medium text-sm">{t.chooseText}</legend>
      <RadioGroup name="text" value={text} onValueChange={({ value }) => setText(value ?? '')} aria-label={t.chooseText}>
        <div className="flex flex-wrap gap-2">{candidates.map(candidate => <RadioGroupItem key={candidate.contribution}
          className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-sm
            has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/32" value={candidate.contribution}>

          {languageName(candidate.language, locale)}</RadioGroupItem>)}</div>
      </RadioGroup>
    </fieldset> : <p className="text-muted-foreground text-sm">
      {t.submittingText({ language: languageName(candidates[0]!.language, locale) })}</p>}
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-1 font-medium text-sm">{t.chooseRealm}</legend>
      <EntityPicker label={browseMessages[locale].chooseCommunity} locale={locale} load={load} value={selection}
        disabled={busy} onValueChange={next => {
          if (next[0]?.item.disabled) return;
          setSelection(next);
          setResult(null);
          const chosen = next[0]?.item.realm;
          if (!chosen || chosen.reviewMode) return;
          void (main ?? browserMainApi()).v1.realms({ realm: chosen.id.slice(-36) }).get({ query: { actingSubject: agent.iri } })
            .then(read => {
              if (!read.data) return;
              const reviewMode = read.data.reviewMode;
              setSelection(current => current[0]?.item.value === chosen.id
                ? current.map(entry => ({ ...entry, item: { ...entry.item, realm: { ...entry.item.realm, reviewMode } } })) : current);
            }).catch(() => {});
        }} />
      {realm ? <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        <ModeIcon mode={realm.reviewMode} />{reviewModeText(realm.reviewMode, t)}</p> : null}
    </fieldset>
    {result ? result.ok ? <p role="status" className="flex items-center gap-2 text-sm text-success-foreground">
      <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0" />{result.text}</p>
      : <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
        <AlertDescription role="alert" className="text-destructive-foreground">{result.text}</AlertDescription></Alert> : null}
    <p className="text-muted-foreground text-xs">{t.submitHelp}</p>
    <Button type="submit" className="justify-self-start" disabled={!realm || busy} isLoading={busy}>
      {busy ? t.submitting : t.submit}</Button>
  </form>;
}
