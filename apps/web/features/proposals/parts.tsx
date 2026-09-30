import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { CircleAlertIcon, ExternalLinkIcon } from 'lucide-react';
import type { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { agentLabel, dateTime, isoTime, relativeTime } from '../manage/format.ts';
import type { AgentSummary } from '../manage/types.ts';
import { webHref } from './candidate.ts';
import { blockerKey } from './blockers.ts';
import { type Leaf, leaves } from './diff.ts';
import { eventMessage, factKey, reviewKey, stateKey, stateTone } from './labels.ts';
import type { ProposalMessages } from './messages.ts';
import type { Blocker, Change, Evidence, ProposalState, ProposalRead, TimelineEntry } from './types.ts';

export type T = ReturnType<typeof materializeData<ProposalMessages>>;
export type Agents = Record<string, AgentSummary>;

export function StateBadge({ state, t }: { state: ProposalState; t: T }) {
  return <Badge variant={stateTone[state]} size="md">{t[stateKey[state]]}</Badge>;
}

/** A person's public name, or "Agent 1a2b3c4d" until Main names them. */
export const agentName = (iri: string, agents: Agents, t: T) => agentLabel(agents[iri], iri, id => t.agentFallback({ id }));

const languageName = (tag: string, locale: UiLocale) => {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
};

function factLabel(leaf: Leaf, t: T): string {
  const name = [...leaf.path].reverse().find(part => part in factKey) ?? leaf.path[0]!;
  const key = (factKey as Record<string, keyof ProposalMessages>)[name];
  return key ? String(t[key]) : leaf.path.join(' › ');
}

function Value({ text, language, label, unset, tone }: { text: string | null; language: string | null; label: string;
  unset: string; tone: 'before' | 'after' }) {
  return <div className={cn('grid gap-1 rounded-xl px-3 py-2.5 text-sm',
    tone === 'before' ? 'bg-muted/60' : 'bg-primary/10')}>
    <span className="font-medium text-muted-foreground text-xs">{label}</span>
    {text === null ? <span className="text-muted-foreground">{unset}</span>
      : <span dir="auto" {...language ? { lang: language } : {}} className="whitespace-pre-line text-pretty">{text}</span>}
  </div>;
}

/**
 * What the proposal would change, as Main's preview lists it: each changed
 * fact with its value before and after, in the language it is written in.
 * The page does not know kinds; it shows the changed leaves of any preview.
 */
export function ChangeList({ changes, locale, t }: { changes: readonly Change[]; locale: UiLocale; t: T }) {
  const rows = leaves(changes);
  if (!rows.length) return <p className="text-muted-foreground text-sm">{t.changesEmpty}</p>;
  return <ul className="grid gap-4">
    {rows.map(leaf => <li key={leaf.key} className="grid gap-2">
      <h4 className="font-medium text-sm">{factLabel(leaf, t)}{leaf.language
        ? <span className="font-normal text-muted-foreground"> · {t.inLanguage({ language: languageName(leaf.language, locale) })}</span>
        : null}</h4>
      <div className="grid gap-2 sm:grid-cols-2">
        <Value text={leaf.before} language={leaf.language} label={t.before} unset={t.unset} tone="before" />
        <Value text={leaf.after} language={leaf.language} label={t.after} unset={t.unset} tone="after" />
      </div>
    </li>)}
  </ul>;
}

/** The sources attached to a revision; a web address is a link. */
export function EvidenceList({ evidence, locale, t }: { evidence: readonly Evidence[]; locale: UiLocale; t: T }) {
  if (!evidence.length) return <p className="text-muted-foreground text-sm">{t.evidenceNone}</p>;
  return <ul className="grid gap-2">
    {evidence.map((item, index) => {
      const href = webHref(item.resource);
      const read = /^retrieved:(\d{4}-\d{2}-\d{2})$/.exec(item.revision)?.[1];
      return <li key={`${item.resource}-${index}`} className="grid gap-0.5 rounded-xl bg-muted/40 px-3 py-2.5 text-sm">
        {href ? <a href={href} rel="noopener noreferrer nofollow" target="_blank"
          className="flex items-center gap-1.5 break-all font-medium text-primary hover:underline">
          {item.resource}<ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" /></a>
          : <span className="break-all font-medium">{item.resource}</span>}
        <span className="text-muted-foreground text-xs">
          {[item.locator ? t.evidenceWhere({ locator: item.locator }) : null,
            read ? t.evidenceRead({ date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' })
              .format(new Date(`${read}T00:00:00Z`)) }) : null].filter(Boolean).join(' · ')}</span>
      </li>;
    })}
  </ul>;
}

/** The sentence for one typed blocker. */
export function blockerText(blocker: Blocker, t: T): string {
  const key = blockerKey[blocker.code];
  switch (blocker.code) {
    case 'stale_revision': return t.blockerStaleRevision({ latest: String(blocker.latestRevision) });
    case 'required_approvals': return t.blockerRequiredApprovals({ required: String(blocker.required),
      received: String(blocker.received) });
    case 'terminal_decision': return t.blockerTerminal({ outcome: t[stateKey[blocker.outcome]] });
    default: return String(t[key as Exclude<typeof key, 'blockerStaleRevision' | 'blockerRequiredApprovals'
      | 'blockerTerminal'>]);
  }
}

/** Why an action is not offered, as Main's typed blockers say; nothing is worked out here. */
export function BlockerList({ blockers, stale, staleComplete, t }: { blockers: readonly Blocker[]; stale: number;
  staleComplete: boolean; t: T }) {
  if (!blockers.length && !stale) return null;
  return <Alert variant="warning" role="status">
    <CircleAlertIcon aria-hidden="true" />
    <AlertDescription>
      <ul className="grid gap-1 text-foreground">
        {blockers.map(blocker => <li key={blocker.code}>{blockerText(blocker, t)}</li>)}
        {stale ? <li>{t.staleApprovals({ count: staleComplete ? String(stale) : `${stale}+` })}</li> : null}
      </ul>
    </AlertDescription>
  </Alert>;
}

function stepText(entry: TimelineEntry, agents: Agents, t: T) {
  const key = eventMessage(entry) as keyof ProposalMessages;
  const text = t[key];
  return typeof text === 'function' ? (text as (input: { agent: string }) => string)({
    agent: agentName(entry.actor, agents, t) }) : String(text);
}

/** The steps so far, oldest first, each naming its revision; a review shows its stance and message. */
export function Timeline({ timeline, agents, now, locale, t, href }: { timeline: ProposalRead['timeline'];
  agents: Agents; now: number; locale: UiLocale; t: T; href: (revision: number) => string }): ReactNode {
  return <ol className="grid gap-4 border-border border-s ps-4">
    {timeline.map(entry => <li key={entry.sequence} className="relative grid gap-1 text-sm">
      <span aria-hidden="true" className="-start-[1.3125rem] absolute top-1.5 size-2.5 rounded-full bg-primary" />
      <p>{stepText(entry, agents, t)}
        {' '}<a href={href(entry.revision)} className="text-muted-foreground hover:underline">
          {t.atRevision({ n: String(entry.revision) })}</a>
        {' · '}<time dateTime={isoTime(entry.occurredAt)} title={dateTime(entry.occurredAt, locale)}
          suppressHydrationWarning className="text-muted-foreground">{relativeTime(entry.occurredAt, now, locale)}</time></p>
      {entry.review ? <div className="grid gap-1 rounded-xl bg-muted/40 px-3 py-2.5">
        <span className="font-medium text-xs">{String(t[(reviewKey as Record<string, keyof ProposalMessages>)[
          entry.review.outcome] ?? 'reviewComment'])}</span>
        {entry.review.message ? <span dir="auto" className="whitespace-pre-line text-pretty">{entry.review.message}</span> : null}
      </div> : null}
    </li>)}
  </ol>;
}
