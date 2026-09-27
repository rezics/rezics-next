'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Kbd } from '@rezics/ui/kbd';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { ArrowUpRightIcon, CircleAlertIcon, InfoIcon, SirenIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { agentLabel, dateTime, relativeTime, shownHandle } from './format.ts';
import { actionLabel, componentLabel, kindLabel, reasonText, shortcutKeys, stateLabel } from './labels.ts';
import type { ManageMessages } from './messages.ts';
import { AgentMark, Named, Thumb } from './parts.tsx';
import { isReport, type QueueAction, type QueueAuthority } from './queue-state.ts';
import { type AgentSummary, type DecisionBasis, type Loaded, type ModerationItem, uuidOf, type WorkSummary } from './types.ts';

/** The order decisions are offered in, everywhere: yes, no, back to the author, then to the owners. */
export const actionOrder: readonly QueueAction[] = ['approve', 'keep', 'reject', 'remove', 'request-changes', 'escalate'];

/** Whether the Realm has published rules a keep or remove decision can cite, as the reports read so far say. */
export type RulesState = 'published' | 'missing' | 'unknown';

type T = ReturnType<typeof materializeData<ManageMessages>>;

/** Why an open report or complaint cannot be decided here, and who can act instead; null when nothing is in the way. */
function ReportNote({ item, authority, rules, rulesHref, t }: { item: ModerationItem; authority: QueueAuthority;
  rules: RulesState; rulesHref: string | null; t: T }) {
  let text: string | null = null;
  let link: React.ReactNode = null;
  if (item.kind === 'rights_complaint') {
    text = !authority.escalate ? t.rightsDecisionsOwner : item.escalation ? t.alreadyEscalated : t.rightsDecisionsLater;
  } else if (authority.decideReports && rules === 'missing') {
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
          report.actingSubject, id => t.agentFallback({ id })) })} · <time dateTime={report.receivedAt}
          title={dateTime(report.receivedAt, locale)}>{relativeTime(report.receivedAt, now, locale)}</time></p>
        {report.statement ? <p dir="auto" className="whitespace-pre-line">{report.statement}</p>
          : <p className="text-muted-foreground">{t.noStatement}</p>}
      </li>)}
    </ul>
  </div>;
}

function Person({ iri, agents, label, now, locale, messages, time }: {
  iri: string | null; agents: Record<string, AgentSummary>; label: (agent: string) => string; now: number;
  time: string; locale: UiLocale; messages: ManageMessages;
}) {
  const t = materializeData(messages, { locale });
  const name = iri ? agentLabel(agents[iri], iri, id => t.agentFallback({ id })) : t.unknownAuthor;
  const handle = iri ? shownHandle(agents[iri]?.handle ?? null) : null;
  return <div className="flex items-center gap-2.5 text-sm">
    <AgentMark name={name} iri={iri ?? 'unknown'} />
    <p className="min-w-0">
      <span>{label(name)}</span>
      {handle ? <span className="ms-1.5 text-muted-foreground">{handle}</span> : null}
      <span className="block text-muted-foreground text-xs"><time dateTime={time} title={dateTime(time, locale)}>
        {relativeTime(time, now, locale)}</time></span>
    </p>
  </div>;
}

/** One queue item in context: what it points at, who raised it, and the decisions it allows. */
export function QueueDetail({ item, agents, works, draft, basis, allowed, authority, rules, rulesHref, onAct, now, locale,
  messages, className }: {
  item: ModerationItem | null; agents: Record<string, AgentSummary>; works: Record<string, WorkSummary>;
  draft: Loaded<{ text: string; language: string }> | 'loading' | undefined;
  /** A report's decision basis: its reports' words and the rules a decision cites. */
  basis?: Loaded<DecisionBasis> | 'loading';
  allowed: ReadonlySet<QueueAction>; authority: QueueAuthority; rules: RulesState;
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
  const work = item.target.owner === 'graph' ? works[item.target.resource] : undefined;
  const title = work?.title.value ?? t.workFallback;
  const reason = reasonText(item, t);
  const report = isReport(item);
  const decidable = actionOrder.filter(action => allowed.has(action));
  return <section aria-labelledby={`queue-detail-${item.id}`} className={cn('grid gap-5 rounded-2xl border border-border/60 bg-card p-5',
    className)}>
    <header className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant={report ? 'secondary' : 'soft'}>{kindLabel(item.kind, t)}</Badge>
      <span className="text-muted-foreground">{stateLabel(item, t)}</span>
      {item.escalation ? <Badge variant="outline" className="gap-1"><SirenIcon aria-hidden="true" />{t.escalatedBadge}</Badge>
        : null}
    </header>
    <div className="flex gap-4">
      <Thumb image={work?.cover ?? null} label={title} fallbackKey={item.target.resource} shape="cover" className="w-16" />
      <div className="min-w-0 space-y-1.5">
        <h3 id={`queue-detail-${item.id}`} className="font-work-title text-xl leading-snug">
          {work ? <Named name={work.title} /> : title}</h3>
        {work?.originalTitle && work.originalTitle !== work.title.value
          ? <p className="text-muted-foreground text-sm" dir="auto">{work.originalTitle}</p> : null}
        {item.target.owner === 'graph' ? <LocalizedLink href={`/w/${uuidOf(item.target.resource)}`}
          className="inline-flex items-center gap-1 rounded-md font-medium text-primary text-sm outline-none
            hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          {t.openWork}<ArrowUpRightIcon aria-hidden="true" className="size-3.5" /></LocalizedLink>
          : null}
        {!work && item.target.owner === 'graph' ? <p className="text-muted-foreground text-xs">{t.workUnavailable}</p> : null}
      </div>
    </div>
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      {report ? <div><dt className="text-muted-foreground text-xs">{t.reportedPart}</dt>
        <dd className="font-medium">{componentLabel(item.target.component, t)}</dd></div> : null}
      {reason ? <div className={report ? undefined : 'sm:col-span-2'}><dt className="text-muted-foreground text-xs">
        {t.reasonLabel}</dt><dd className="font-medium" dir="auto">{reason}</dd></div> : null}
    </dl>
    <Person iri={item.authorAgent} agents={agents} now={now} time={item.openedAt} locale={locale} messages={messages}
      label={agent => item.kind === 'rights_complaint' ? t.complainedBy({ agent }) : report ? t.reportedBy({ agent })
        : t.submittedBy({ agent })} />
    {item.kind === 'content_report' ? <Reports basis={basis} agents={agents} now={now} locale={locale} messages={messages} />
      : null}
    {item.submission ? <div className="grid gap-2">
      <h4 className="font-medium text-muted-foreground text-xs">{t.submittedText}</h4>
      {draft === 'loading' || draft === undefined ? <div className="grid gap-2"><Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-2/3" /></div>
        : draft.ok ? <blockquote lang={draft.data.language} dir="auto" className="max-h-64 overflow-y-auto whitespace-pre-line
          rounded-xl border-primary/40 border-s-2 bg-muted/40 px-4 py-3 font-work-title leading-relaxed">{draft.data.text}</blockquote>
          : <p className="text-muted-foreground text-sm">{t.textUnavailable}</p>}
      {item.submission.correctionOf ? <p className="text-muted-foreground text-sm">{t.replacesSelection}</p> : null}
    </div> : null}
    {item.escalation ? <Alert variant="warning">
      <SirenIcon aria-hidden="true" />
      <AlertDescription>
        <p>{t.escalatedBy({ agent: agentLabel(agents[item.escalation.actingSubject], item.escalation.actingSubject,
          id => t.agentFallback({ id })), time: relativeTime(item.escalation.escalatedAt, now, locale) })}</p>
        <p className="mt-1 text-foreground" dir="auto">{item.escalation.reason}</p>
      </AlertDescription>
    </Alert> : null}
    <div className="grid gap-3 border-border/60 border-t pt-4">
      {decidable.length ? <div role="group" aria-label={t.itemActions} className="flex flex-wrap gap-2">
        {decidable.map(action => <Button key={action} size="sm" onClick={() => onAct(action)}
          variant={action === 'approve' || action === 'keep' ? 'default'
            : action === 'reject' || action === 'remove' ? 'destructive' : 'outline'}
          aria-keyshortcuts={shortcutKeys[action]}>
          {actionLabel(action, t)}<Kbd className="ms-1 bg-transparent" aria-hidden="true">{shortcutKeys[action].toUpperCase()}</Kbd>
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
