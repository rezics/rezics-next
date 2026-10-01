'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Kbd } from '@rezics/ui/kbd';
import { cn } from '@rezics/ui/utils';
import { ClockIcon, LockIcon, SirenIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type Text, textFor, keyed } from '../safety/report.ts';
import { dateTime, readableCode } from './format.ts';
import type { ManageMessages } from './messages.ts';
import { decideLabelKey } from './safety-decision-dialog.tsx';
import { type Claim, deadlineOf, isRevisit, permittedOutcomes, restricts, span } from './safety-state.ts';
import type { ReportEvidence, SafetyCase, SafetyDecisionResult, SafetyItem, SafetyOutcome } from './safety-types.ts';
import type { Loaded } from './types.ts';

type T = ReturnType<typeof materializeData<ManageMessages>>;

export const categoryName = (category: string | null, text: Text) =>
  category ? keyed(text, 'cat', category, readableCode(category)) : null;

const outcomeKeys = { restrict: 'outcomeRestrict', interim_restrict: 'outcomeInterim', final_restrict: 'outcomeFinal',
  dismiss: 'outcomeDismiss', restore: 'outcomeRestore', reverse: 'outcomeReverse' } as const;
export const outcomeText = (outcome: string, t: T) =>
  outcome in outcomeKeys ? t[outcomeKeys[outcome as keyof typeof outcomeKeys]] : readableCode(outcome);

const operationKeys = { accepted: 'operationAccepted', completed: 'operationCompleted', partial: 'operationPartial',
  cancelled: 'operationCancelled' } as const;
const effectKeys = { confirmed: 'effectConfirmed', pending: 'effectPending', uncertain: 'effectUncertain',
  failed: 'effectFailed' } as const;
const keyFor = { restrict: 'r', interim_restrict: 'r', final_restrict: 'f', dismiss: 'd', restore: 'e', reverse: 'v' } as const;
/** The shortcut key each decision has in keyboard triage. */
export const decisionKey = (outcome: SafetyOutcome) => keyFor[outcome];

/** The one-line summary a queue row and its accessible name use: category and kind. */
export function summaryOf(item: SafetyItem, t: T, text: Text): string {
  return [categoryName(item.category, text) ?? (item.kind === 'rights_complaint' ? t.kindRightsComplaint : t.kindContentReport),
    item.urgent ? t.caseUrgent : null, isRevisit(item) ? t.caseRevisit : null].filter(Boolean).join(' · ');
}

/** The case's time left or overdue, as a chip with the clock. */
export function DeadlineChip({ dueAt, now, locale, messages }: { dueAt: string | null; now: number; locale: UiLocale;
  messages: ManageMessages }) {
  const t = materializeData(messages, { locale });
  const deadline = deadlineOf(dueAt, now);
  if (deadline.kind === 'none') return null;
  const overdue = deadline.kind === 'overdue';
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs',
    overdue ? 'bg-destructive/10 text-destructive-foreground' : 'bg-muted text-foreground')}>
    <ClockIcon aria-hidden="true" className="size-3.5" />
    <time dateTime={dueAt!}>{overdue ? t.caseOverdue({ time: span(deadline.ms, locale) })
      : t.caseLeft({ time: span(deadline.ms, locale) })}</time>
  </span>;
}

export function ClaimChip({ claim, agent, locale, messages }: { claim: Claim; agent: string | null; locale: UiLocale;
  messages: ManageMessages }) {
  const t = materializeData(messages, { locale });
  if (claim === 'free') return null;
  return <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground text-xs">
    {claim === 'mine' ? t.claimedByYou : t.claimedByOther({ agent: agent ?? '' })}</span>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="grid gap-2">
    <h3 className="font-semibold text-sm">{title}</h3>
    {children}
  </section>;
}

export type CaseProblem = 'claim-taken' | 'claim-denied' | 'claim-failed' | null;

/**
 * One case as staff read it: what Main says about it, its deadline, its
 * evidence, any decision, and the decisions that fit. Nothing here is decided
 * locally; a refused read shows as restricted evidence.
 */
export function SafetyCasePanel({ item, detail, evidence, claim, claimedLabel, claiming, problem, now, locale, messages,
  advanced, lastDecision, onClaim, onDecide, onRefresh, className }: {
  item: SafetyItem; detail: Loaded<SafetyCase> | undefined; evidence: Loaded<ReportEvidence> | null | undefined;
  claim: Claim; claimedLabel: string | null; claiming: boolean; problem: CaseProblem; now: number; locale: UiLocale;
  messages: ManageMessages; advanced: boolean;
  /** What this session just recorded, kept so its words stay readable after the dialog closes. */
  lastDecision: { result: SafetyDecisionResult; facts: string } | null;
  onClaim: () => void; onDecide: (outcome: SafetyOutcome) => void; onRefresh: () => void; className?: string;
}) {
  const t = materializeData(messages, { locale });
  const text = textFor(locale);
  const restricted = detail !== undefined && !detail.ok && detail.failure === 'denied' && item.urgent;
  const category = categoryName(item.category, text);
  const outcomes = permittedOutcomes(item);
  return <article aria-label={summaryOf(item, t, text)} className={cn('grid content-start gap-5 rounded-2xl border border-border/60 bg-card p-4 sm:p-5', className)}>
    <header className="grid gap-2">
      <h2 className="flex flex-wrap items-center gap-2 font-semibold text-lg tracking-tight">
        {item.urgent ? <SirenIcon aria-hidden="true" className="size-5 text-destructive-foreground" /> : null}
        {category ?? (item.kind === 'rights_complaint' ? t.kindRightsComplaint : t.kindContentReport)}</h2>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
        {item.openedAt ? <span>{t.caseReceived({ time: dateTime(item.openedAt, locale) })}</span> : null}
        <DeadlineChip dueAt={item.dueAt} now={now} locale={locale} messages={messages} />
        {isRevisit(item) ? <span className="rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning-foreground text-xs">
          {t.caseRevisit}</span> : null}
        <ClaimChip claim={claim} agent={claimedLabel} locale={locale} messages={messages} />
      </div>
    </header>

    {restricted ? <Alert role="note"><LockIcon aria-hidden="true" />
      <AlertDescription><strong className="block">{t.restrictedTitle}</strong>{t.restrictedHelp}</AlertDescription></Alert> : null}
    {detail && !detail.ok && !restricted ? <Alert variant="destructive" role="alert">
      <AlertDescription>{t.unavailableHelp}{' '}
        <Button type="button" size="xs" variant="outline" onClick={onRefresh}>{t.refreshCase}</Button></AlertDescription></Alert> : null}
    {detail === undefined ? <p role="status" className="text-muted-foreground text-sm">{t.loadingMore}</p> : null}

    {item.category === 'ncii' ? <Section title={t.deadlineHeading}>
      <p className="font-medium text-sm">{t.nciiNotice}</p>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t.caseReceived({ time: dateTime(item.openedAt, locale) })}</span>
        <DeadlineChip dueAt={item.dueAt} now={now} locale={locale} messages={messages} /></p>
    </Section> : null}
    {item.category === 'copyright' ? <Section title={t.deadlineHeading}>
      <p className="font-medium text-sm">{t.dmcaNotice}</p>
      {item.dueAt ? <><p className="text-sm">{t.dmcaEarliest({ time: dateTime(item.dueAt, locale) })}</p>
        <p className="text-muted-foreground text-sm">{t.dmcaLatest}</p></> : null}
    </Section> : null}

    {detail?.ok ? <>
      <Section title={t.safetyReportsHeading}>
        <ul className="grid gap-1 text-sm">{detail.data.reports.map(report => <li key={report.reportId}>
          {t.reportEntry({ category: categoryName(report.category, text) ?? report.category,
            digest: report.evidenceDigest.slice(0, 12) })}</li>)}</ul>
        {detail.data.reportsNextCursor ? <p className="text-muted-foreground text-xs">{t.reportsMore}</p> : null}
      </Section>
      <Section title={t.evidenceHeading}>
        {evidence === undefined ? <p role="status" className="text-muted-foreground text-sm">{t.loadingMore}</p>
          : evidence === null ? <p className="text-muted-foreground text-sm">{t.evidenceNone}</p>
            : !evidence.ok ? <p className="text-muted-foreground text-sm">
              {evidence.failure === 'denied' ? t.restrictedHelp : t.evidenceFailed}</p>
              : evidence.data.evidence.length ? <ul className="grid gap-1 text-sm">{evidence.data.evidence.map(entry =>
                <li key={entry.ordinal} className="grid gap-0.5">
                  <span className="[overflow-wrap:anywhere]">{entry.resource}</span>
                  <span className="text-muted-foreground text-xs">{t.evidenceEntry({ owner: entry.owner,
                    component: entry.component, state: entry.state })}{entry.revision
                    ? ` · ${t.evidenceRevision({ revision: entry.revision })}` : ''}</span></li>)}</ul>
                : <p className="text-muted-foreground text-sm">{t.evidenceNone}</p>}
      </Section>
      <Section title={t.correspondenceHeading}>
        <p className="text-muted-foreground text-sm">{t.correspondenceHelp}</p>
      </Section>
      <Section title={t.decisionHeading}>
        {detail.data.decision ? <>
          <p className="font-medium text-sm">{t.decisionEntry({ outcome: outcomeText(detail.data.decision.outcome, t),
            generation: detail.data.decision.caseGeneration })}</p>
          <p className="text-sm" role="status">{t[operationKeys[detail.data.decision.operation.status as
            keyof typeof operationKeys] ?? 'operationAccepted']}</p>
          {detail.data.decision.enforcement.length ? <ul className="grid gap-0.5 text-muted-foreground text-xs">
            {detail.data.decision.enforcement.map(effect => <li key={`${effect.resource}:${effect.effect}`}
              className="[overflow-wrap:anywhere]">{t.effectEntry({ target: effect.resource,
              state: t[effectKeys[effect.state as keyof typeof effectKeys] ?? 'effectPending'] })}</li>)}</ul> : null}
        </> : <p className="text-muted-foreground text-sm">{t.noDecision}</p>}
        {lastDecision && lastDecision.result.caseId === item.caseId
          ? <p className="whitespace-pre-line text-sm [overflow-wrap:anywhere]">{lastDecision.facts}</p> : null}
      </Section>

      <div className="grid gap-2 border-border/60 border-t pt-4">
        {claim === 'free' ? <>
          <p className="text-muted-foreground text-sm">{t.claimHelp}</p>
          <div><Button type="button" onClick={onClaim} isLoading={claiming} disabled={claiming}>
            {claiming ? t.claiming : t.claimCase}{advanced ? <Kbd aria-hidden="true" className="ms-2">C</Kbd> : null}</Button></div>
        </> : claim === 'other' ? <p className="text-muted-foreground text-sm">{t.decideNeedsClaim}</p> : <>
          {isRevisit(item) ? <p className="text-muted-foreground text-sm">{t.revisitHelp}</p> : null}
          <div className="flex flex-wrap gap-2" role="group" aria-label={t.decisionHeading}>
            {outcomes.map(outcome => <Button key={outcome} type="button"
              variant={restricts(outcome) ? 'destructive' : 'outline'} onClick={() => onDecide(outcome)}>
              {t[decideLabelKey[outcome]]}{advanced ? <Kbd aria-hidden="true" className="ms-2">{decisionKey(outcome).toUpperCase()}</Kbd>
                : null}</Button>)}
          </div>
        </>}
        {problem ? <Alert variant="destructive" role="alert"><AlertDescription>{
          problem === 'claim-taken' ? t.claimTaken : problem === 'claim-denied' ? t.claimDenied : t.claimFailed}
        </AlertDescription></Alert> : null}
      </div>
    </> : null}
  </article>;
}
