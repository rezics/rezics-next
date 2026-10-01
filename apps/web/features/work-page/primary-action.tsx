import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { LayersIcon, PlayIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { copyOf as trackingCopy } from '../tracking/messages.ts';
import type { EditionPreference, ProgressSummary } from '../tracking/types.ts';
import { ACTION_ATTRIBUTE, hubAnchors } from './hub.ts';
import { languageName } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import type { ReadStart } from './read.ts';
import { idOf } from './route.ts';
import type { Loaded } from './types.ts';
import { ReadButton } from './work-frame.tsx';
import type { WorkAt } from './route.ts';

// The one action a Work's identity leads with. Main decides what is next (G-835's progress summary and the
// reader's edition preference); this only maps its answers to a button and renders it.

export type NextAction =
  /** Hosted text to read: chapters, a text, or Contents when Main could not say. */
  | { kind: 'read'; start: NonNullable<ReadStart> }
  /** The next part of a composition, as Main names it. `continue` once the reader has finished a part. */
  | { kind: 'part'; mode: 'continue' | 'start'; href: string; part: string | null }
  /** The Work has releases and nothing says which edition the reader uses. */
  | { kind: 'choose' };

type Series = Extract<ProgressSummary, { scope: 'disclosed-composition' }>;

/**
 * Which action leads, in this order: text the reader can open here, the next part Main names, choosing an
 * edition when releases exist and none is chosen. A Work with none of these has no primary action, and the
 * shelf leads instead.
 */
export function nextAction({ start, progress, preference, releases }: {
  start: ReadStart; progress: Loaded<ProgressSummary> | null; preference: Loaded<EditionPreference | null> | null;
  /** How many releases Main lists for the Work; zero when it could not say. */
  releases: number;
}): NextAction | null {
  if (start) return { kind: 'read', start };
  const series: Series | null = progress?.ok && progress.data.scope === 'disclosed-composition' ? progress.data : null;
  const next = series?.next;
  const chosen = Boolean(preference?.ok && preference.data?.edition);
  // A part with no text in the reader's language is a choice of edition, not something to start.
  if (next && next.reason !== 'awaiting_chosen_language') {
    const work = idOf(next.part.work);
    if (work) {
      return { kind: 'part', mode: series?.furthestCompleted ? 'continue' : 'start', href: `/w/${work}`,
        part: next.part.displayLabel || null };
    }
  }
  return releases > 0 && !chosen ? { kind: 'choose' } : null;
}

export function NextActionView({ action, workRef, locale, messages }: {
  action: NextAction; workRef: WorkAt; locale: UiLocale; messages: WorkPageMessages;
}) {
  if (action.kind === 'read') return <ReadButton workRef={workRef} start={action.start} messages={messages} />;
  const button = cn(buttonVariants({ size: 'lg', pill: true }), 'w-full');
  if (action.kind === 'choose') {
    return <a href={`#${hubAnchors.availability}`} {...{ [ACTION_ATTRIBUTE]: '' }} className={button}><LayersIcon aria-hidden="true" />
      {messages.chooseRelease}</a>;
  }
  return <div className="grid gap-1.5">
    <Link href={action.href} {...{ [ACTION_ATTRIBUTE]: '' }} className={button}>
      <PlayIcon aria-hidden="true" />{action.mode === 'continue' ? messages.continueNext : messages.startFirst}</Link>
    {action.part ? <p className="truncate text-center text-muted-foreground text-xs">
      {materializeData(messages, { locale }).upNext({ part: action.part })}</p> : null}
  </div>;
}

/**
 * Where the reader stands, in Main's words: the edition they chose and their progress through the Work. Quiet
 * when Main has nothing to say, which is also the signed-out answer.
 */
export function IdentityStatus({ progress, preference, editionName, locale, messages }: {
  progress: Loaded<ProgressSummary> | null; preference: Loaded<EditionPreference | null> | null;
  /** The name of the chosen realization or release, when Main could name it. */
  editionName: string | null; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const tracking = trackingCopy(locale);
  const lines: string[] = [];
  const chosen = preference?.ok ? preference.data : null;
  if (chosen) {
    lines.push(t.editionLine({ edition: editionName ?? languageName(chosen.language, locale) }));
  }
  if (progress?.ok) {
    const summary = progress.data;
    if (summary.scope === 'disclosed-composition') {
      if (summary.counts.required) {
        lines.push(tracking.countsLine({ count: summary.counts.required,
          completedRequired: String(summary.counts.completedRequired) }));
      }
    } else if (summary.status) {
      lines.push(summary.status === 'finished' ? tracking.stateFinished
        : summary.status === 'reading' ? tracking.stateActive : tracking.notStarted);
    }
  }
  if (!lines.length) return null;
  return <ul aria-label={t.yourEdition} className="grid gap-0.5 text-muted-foreground text-sm" data-identity-status>
    {lines.map(line => <li key={line}>{line}</li>)}
  </ul>;
}
