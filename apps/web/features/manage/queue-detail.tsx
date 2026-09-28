'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Kbd } from '@rezics/ui/kbd';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { CircleAlertIcon, InfoIcon, SirenIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { agentLabel, dateTime, isoTime, relativeTime } from './format.ts';
import { actionLabel, componentLabel, isSpoilerReason, kindLabel, reasonText, ruleFor, shortcutKeys,
  stateLabel } from './labels.ts';
import type { ManageMessages } from './messages.ts';
import type { QueueNames } from './queue-api.ts';
import { HubText, ModFacts, PersonCard, RealmRules, RuleNote, SpoilerText, SubjectHeader } from './queue-context.tsx';
import { isReport, type QueueAction, type QueueAuthority } from './queue-state.ts';
import { inChapters, reviewedAs, subjectOf } from './queue-subject.ts';
import type { AgentSummary, DecisionBasis, Loaded, ModerationItem, PublishedRule } from './types.ts';

/** The order decisions are offered in, everywhere: yes, no, back to the author, then to the owners. */
export const actionOrder: readonly QueueAction[] = ['approve', 'keep', 'reject', 'remove',
  'interim-restrict', 'final-restrict', 'request-changes', 'escalate'];

/** Whether the Realm has published rules a keep or remove decision can cite, as the reports read so far say. */
export type RulesState = 'published' | 'missing' | 'unknown';

type T = ReturnType<typeof materializeData<ManageMessages>>;

/** Why an open report or complaint cannot be decided here, and who can act instead; null when nothing is in the way. */
function ReportNote({ item, authority, rules, rulesHref, t }: { item: ModerationItem; authority: QueueAuthority;
  rules: RulesState; rulesHref: string | null; t: T }) {
  let text: string | null = null;
  let link: ReactNode = null;
  if (authority.decideReports && rules === 'missing') {
    text = rulesHref ? t.rulesNeeded : `${t.rulesNeeded} ${t.askOwnerRules}`;
    link = rulesHref ? <LocalizedLink href={rulesHref} className="font-medium text-primary hover:underline">
      {t.publishRules}</LocalizedLink> : null;
  } else if (!authority.decideReports) {
    text = authority.escalate && !item.escalation ? t.reportsNeedModerator : t.alreadyEscalated;
  } else if (item.escalation && authority.escalate) text = t.alreadyEscalated;
  if (!text) return null;
  return <p className="flex gap-2 text-muted-foreground text-sm">
    <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
    <span>{text}{link ? <> {link}</> : null}</span></p>;
}

/** What each report of a case says, for moderators only: who reported it, when, and their own words. */
function Reports({ basis, agents, now, locale, messages }: { basis: Loaded<DecisionBasis> | 'loading' | undefined;
  agents: Record<string, AgentSummary>; now: number; locale: UiLocale; messages: ManageMessages }) {
  const t = materializeData(messages, { locale });
  if (basis === undefined || basis !== 'loading' && !basis.ok) return null;
  if (basis === 'loading') return <div className="grid gap-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-12 w-full" /></div>;
  const { reports } = basis.data;
  return <div className="grid gap-2">
    <h4 className="font-medium text-muted-foreground text-xs">{basis.data.nextCursor
      ? t.reportsAtLeast({ count: String(reports.length) }) : t.reportsHeading(reports.length)}</h4>
    <ul className="grid gap-2">
      {reports.map(report => <li key={report.id} className="grid gap-1 rounded-xl bg-muted/40 px-3 py-2.5 text-sm">
        <p className="text-muted-foreground text-xs">{t.reporterWrote({ agent: agentLabel(agents[report.actingSubject],
          report.actingSubject, id => t.agentFallback({ id })) })} · <time dateTime={isoTime(report.receivedAt)}
          title={dateTime(report.receivedAt, locale)} suppressHydrationWarning>{relativeTime(report.receivedAt, now, locale)}</time></p>
        {report.statement ? <p dir="auto" className="whitespace-pre-line">{report.statement}</p>
          : <p className="text-muted-foreground">{t.noStatement}</p>}
      </li>)}
    </ul>
  </div>;
}

/**
 * One queue item in context, as its kind needs judging: what it is about
 * (a chapter within its Book, a Work with its cover, authors and hook), the
 * words or facts under review (submitted text, a chapter's opening behind a
 * spoiler flag, a mod's compatibility, a prompt's text), who raised it and
 * their record here, the rule it may break, and the decisions it allows,
 * each with its key.
 */
export function QueueDetail({ item, names, draft, basis, allowed, authority, rules, realmRules = [], rulesHref, onAct,
  now, locale, messages, className }: {
  item: ModerationItem | null; names: QueueNames;
  draft: Loaded<{ text: string; language: string }> | 'loading' | undefined;
  /** A report's decision basis: its reports' words and the rules a decision cites. */
  basis?: Loaded<DecisionBasis> | 'loading';
  allowed: ReadonlySet<QueueAction>; authority: QueueAuthority; rules: RulesState;
  /** The Realm's published rules in the reader's language, numbered as moderators cite them. */
  realmRules?: readonly PublishedRule[];
  /** Settings & rules, for someone who may publish the rules; null otherwise. */
  rulesHref: string | null;
  onAct: (action: QueueAction) => void; now: number; locale: UiLocale; messages: ManageMessages; className?: string;
}) {
  const t = materializeData(messages, { locale });
  if (!item) {
    return <section aria-label={t.noItemTitle} className={cn('rounded-2xl border border-border/80 border-dashed p-8 text-center',
      className)}>
      <h3 className="font-semibold">{t.noItemTitle}</h3>
      <p className="mt-1 text-muted-foreground text-sm">{t.noItemHelp}</p>
    </section>;
  }
  const subject = subjectOf(item.target.resource, names, t.workFallback);
  const facts = names.facts[subject.cover.iri] ?? names.facts[subject.iri];
  const reason = reasonText(item, t);
  const report = isReport(item);
  const cited = report ? ruleFor(item.reasonCode, realmRules) : null;
  const decidable = actionOrder.filter(action => allowed.has(action));
  const spoils = subject.book?.value ?? null;
  const kind = reviewedAs(subject.work);
  return <section aria-labelledby={`queue-detail-${item.id}`} className={cn('grid gap-5 rounded-2xl border border-border/60 bg-card p-5',
    className)}>
    <header className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant={report ? 'secondary' : 'soft'}>{kindLabel(item.kind, t)}</Badge>
      <span className="text-muted-foreground">{stateLabel(item, t)}</span>
      {isSpoilerReason(item.reasonCode) ? <Badge variant="outline">{t.spoilerBadge}</Badge> : null}
      {item.escalation ? <Badge variant="outline" className="gap-1"><SirenIcon aria-hidden="true" />{t.escalatedBadge}</Badge>
        : null}
    </header>
    <SubjectHeader subject={subject} facts={facts} headingId={`queue-detail-${item.id}`} fallback={t.workFallback} t={t} />
    {report || reason ? <dl className="grid gap-3 text-sm sm:grid-cols-2">
      {report ? <div><dt className="text-muted-foreground text-xs">{t.reportedPart}</dt>
        <dd className="font-medium">{componentLabel(item.target.component, t)}</dd></div> : null}
      {reason ? <div className={report ? undefined : 'sm:col-span-2'}><dt className="text-muted-foreground text-xs">
        {t.reasonLabel}</dt><dd className="font-medium" dir="auto">{reason}</dd></div> : null}
    </dl> : null}
    {cited ? <RuleNote rule={cited.rule} number={cited.number} t={t} /> : null}
    {item.kind === 'work_submission' ? <p className="text-sm">
      {inChapters(subject.work) ? t.wholeBookSubmission : t.wholeWorkSubmission}</p> : null}
    {item.kind === 'content-publication_submission' ? <p className="text-sm">{t.publicationSubmission}</p> : null}
    {item.submission?.contribution ? <div className="grid gap-2">
      <SpoilerText heading={t.submittedText} spoils={spoils} loading={draft === 'loading' || draft === undefined}
        text={draft !== 'loading' && draft?.ok ? draft.data.text : null}
        language={draft !== 'loading' && draft?.ok ? draft.data.language : undefined} unavailable={t.textUnavailable} t={t} />
      {item.submission.correctionOf ? <p className="text-muted-foreground text-sm">{t.replacesSelection}</p> : null}
    </div> : subject.book ? <SpoilerText heading={t.chapterText} spoils={spoils} text={subject.chapter?.excerpt ?? null}
      language={subject.chapter?.language} direction={subject.chapter?.direction}
      note={subject.chapter?.truncated ? t.chapterOpening : null} unavailable={t.chapterTextUnavailable} t={t} /> : null}
    {kind === 'mod' ? <ModFacts facts={facts} t={t} /> : null}
    {kind === 'prompt' || kind === 'skill' ? <HubText facts={facts} prompt={kind === 'prompt'} t={t} /> : null}
    <PersonCard iri={item.authorAgent} agents={names.agents} now={now} time={item.openedAt} locale={locale}
      messages={messages} record={item.authorAgent ? names.records[item.authorAgent] : undefined}
      label={agent => item.kind === 'rights_complaint' ? t.complainedBy({ agent }) : report ? t.reportedBy({ agent })
        : t.submittedBy({ agent })} />
    {item.kind === 'content_report' ? <Reports basis={basis} agents={names.agents} now={now} locale={locale}
      messages={messages} /> : null}
    {item.escalation ? <Alert variant="warning">
      <SirenIcon aria-hidden="true" />
      <AlertDescription>
        <p>{t.escalatedBy({ agent: agentLabel(names.agents[item.escalation.actingSubject], item.escalation.actingSubject,
          id => t.agentFallback({ id })), time: relativeTime(item.escalation.escalatedAt, now, locale) })}</p>
        <p className="mt-1 text-foreground" dir="auto">{item.escalation.reason}</p>
      </AlertDescription>
    </Alert> : null}
    <RealmRules rules={realmRules} marked={cited?.rule.id ?? null} t={t} />
    <div className="grid gap-3 border-border/60 border-t pt-4">
      {decidable.length ? <div role="group" aria-label={t.itemActions} className="flex flex-wrap gap-2">
        {decidable.map(action => <Button key={action} size="sm" onClick={() => onAct(action)}
          variant={action === 'approve' || action === 'keep' ? 'default'
            : action === 'reject' || action === 'remove' ? 'destructive' : 'outline'}
          aria-keyshortcuts={shortcutKeys[action]}>
          {actionLabel(action, t)}
          {/* The key that does the same, in the button's own color so it reads on a filled button. */}
          <Kbd className="ms-1 border-current/40 bg-transparent text-current opacity-85 shadow-none" aria-hidden="true">
            {shortcutKeys[action].toUpperCase()}</Kbd>
        </Button>)}
      </div> : null}
      {report && item.state === 'open' ? <ReportNote item={item} authority={authority} rules={rules} rulesHref={rulesHref}
        t={t} /> : null}
      {item.submission?.state === 'deciding' ? <p className="flex gap-2 text-muted-foreground text-sm">
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{t.beingApplied}</p> : null}
      {!decidable.length && !report && item.submission?.state !== 'deciding'
        ? <p className="text-muted-foreground text-sm">{t.noActions}</p> : null}
    </div>
  </section>;
}
