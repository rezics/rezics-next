'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
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
}

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
export function RealmSubmit({ agent, work, texts, realms, open, locale, messages, main }: RealmSubmitProps) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const candidates = texts.ok ? texts.data : [];
  const [text, setText] = useState(candidates[0]?.contribution ?? '');
  const [realm, setRealm] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const keys = useRef<Record<string, string>>({});

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
    const chosen = realms.ok ? realms.data.find(item => item.id === realm) : undefined;
    const candidate = candidates.find(item => item.contribution === text);
    if (!chosen || !candidate) return;
    setBusy(true);
    setResult(null);
    // One key per Realm and text: a retry after a lost answer replays instead of submitting twice.
    const key = keys.current[`${realm}\0${text}`] ??= crypto.randomUUID();
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
      <div className="flex flex-wrap gap-2">{candidates.map(candidate => <label key={candidate.contribution}
        className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-sm
          has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/32">
        <input type="radio" name="text" value={candidate.contribution} checked={text === candidate.contribution}
          onChange={() => setText(candidate.contribution)} className="size-4 accent-primary" />
        {languageName(candidate.language, locale)}</label>)}</div>
    </fieldset> : <p className="text-muted-foreground text-sm">
      {t.submittingText({ language: languageName(candidates[0]!.language, locale) })}</p>}
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-1 font-medium text-sm">{t.chooseRealm}</legend>
      {realms.ok ? realms.data.length ? <div className="grid gap-2">{realms.data.map(option => {
        const reviewing = open.includes(option.id);
        return <label key={option.id} className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border/60
          px-3 py-2.5 has-checked:border-primary has-checked:bg-primary/5 has-disabled:cursor-not-allowed
          has-disabled:opacity-64 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/32">
          <input type="radio" name="realm" value={option.id} checked={realm === option.id} disabled={reviewing}
            onChange={() => setRealm(option.id)} className="mt-1 size-4 accent-primary" />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span lang={option.name.language} className="min-w-0 truncate font-medium text-sm">{option.name.value}</span>
              {reviewing ? <Badge variant="info" size="sm">{t.alreadyInReview}</Badge> : null}</span>
            <span className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <ModeIcon mode={option.reviewMode} />{reviewModeText(option.reviewMode, t)}</span>
          </span>
        </label>;
      })}</div> : <p className="text-muted-foreground text-sm">{t.noRealms}</p>
        : <p className="text-muted-foreground text-sm">{t.realmsFailed}</p>}
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
