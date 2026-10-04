'use client';

import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from '@rezics/ui/segment-group';
import { cn } from '@rezics/ui/utils';
import { useId, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { StarMeter } from '../catalogue/rating.tsx';
import type { ProjectionRead, ScopedRatingApi } from './api.ts';
import { FailureNote } from './failure.tsx';
import { ScoreFigure } from './figure.tsx';
import { formatMean, formatNumber, translate, type Translation } from './format.ts';
import { frameChips } from './frames.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { FrameChips } from './projection-header.tsx';
import { questionText } from './question-rating.tsx';
import { figuresOfMember } from './score.ts';
import type { Outcome, Question, Rollup, RollupFormula } from './types.ts';
import { useLoad } from './use-load.ts';

/** What the members of a roll-up are, in the host's words: the unit that "average of …" and the coverage count. */
export type RollupUnit = 'episodes' | 'chapters' | 'matches' | 'maps' | 'parts';

export function unitName(unit: RollupUnit, t: Translation): string {
  switch (unit) {
    case 'episodes': return t.unitEpisodes;
    case 'chapters': return t.unitChapters;
    case 'matches': return t.unitMatches;
    case 'maps': return t.unitMaps;
    case 'parts': return t.unitParts;
  }
}

/** Main takes at most 200 members of a roll-up, which is ten pages of a subject's places. */
const MAX_MEMBERS = 200;

/** Every place of a subject, page after page, up to what a roll-up can take. */
export async function readAllProjections(api: ScopedRatingApi, subject: string): Promise<Outcome<ProjectionRead[]>> {
  const all: ProjectionRead[] = [];
  let cursor: string | null = null;
  while (all.length < MAX_MEMBERS) {
    const page = await api.projections(subject, cursor);
    if (!page.ok) return page;
    all.push(...page.data.items);
    if (!page.data.nextCursor) break;
    cursor = page.data.nextCursor;
  }
  return { ok: true, data: all.slice(0, MAX_MEMBERS) };
}

function RollupView({ members, question, unit, api, defaultFormula, locale, messages }: {
  members: ProjectionRead[]; question: Question; unit: RollupUnit; api: ScopedRatingApi; defaultFormula: RollupFormula;
  locale: UiLocale; messages: ScopedRatingMessages;
}) {
  const t = translate(messages, locale);
  const noun = unitName(unit, t);
  const [formula, setFormula] = useState<RollupFormula>(defaultFormula);
  const formulaLabel = useId();
  const targets = members.map(member => member.projection.id);
  const [rollup, reload] = useLoad(() => api.rollup(question.context, targets, formula), `${question.context}\n${formula}\n${targets.join()}`);
  const byTarget = new Map(members.map(member => [member.projection.id, member]));
  const text = questionText(question);
  return <section data-rollup aria-label={t.combined({ unit: noun })} className="grid gap-4">
    <div className="grid gap-2">
      <h3 className="font-semibold text-lg tracking-tight">{t.combined({ unit: noun })}</h3>
      <p lang={text.language} dir={text.direction} className="text-muted-foreground text-sm">{text.value}</p>
    </div>
    <div className="grid gap-1.5">
      <span id={formulaLabel} className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{t.combineAs}</span>
      <SegmentGroup aria-labelledby={formulaLabel} value={formula} className="justify-self-start"
        onValueChange={details => { if (details.value === 'pooled' || details.value === 'mean-of-means') setFormula(details.value); }}>
        <SegmentGroupItem value="pooled"><SegmentGroupItemText>{t.formulaPooled}</SegmentGroupItemText></SegmentGroupItem>
        <SegmentGroupItem value="mean-of-means">
          <SegmentGroupItemText>{t.formulaMeanOfMeans({ unit: noun })}</SegmentGroupItemText></SegmentGroupItem>
      </SegmentGroup>
      <p className="text-muted-foreground text-sm">{formula === 'pooled' ? t.explainPooled : t.explainMeanOfMeans({ unit: noun })}</p>
    </div>
    {rollup.state === 'loading' ? <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>
      : rollup.state === 'failed' ? <FailureNote failure={rollup.failure} locale={locale} messages={messages} retry={reload} />
        : <RollupBody rollup={rollup.data} byTarget={byTarget} noun={noun} locale={locale} messages={messages} />}
  </section>;
}

function RollupBody({ rollup, byTarget, noun, locale, messages }: {
  rollup: Rollup; byTarget: Map<string, ProjectionRead>; noun: string; locale: UiLocale; messages: ScopedRatingMessages;
}) {
  const t = translate(messages, locale);
  const available = rollup.members.flatMap(member => member.status === 'available' ? [member] : []);
  const ratings = available.reduce((sum, member) => sum + member.components.count, 0);
  const notAccepted = rollup.members.filter(member => member.status === 'not-accepted').length;
  const unreadable = rollup.members.filter(member => member.status === 'unavailable').length;
  const max = rollup.scale.max;
  return <>
    <div data-rollup-value className="grid gap-1">
      {rollup.value !== null
        ? <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StarMeter mean={rollup.value} max={max} className="text-xl" />
          <span className="font-semibold text-xl tabular-nums">{t.score({ mean: formatMean(rollup.value, locale), max: formatNumber(max, locale) })}
            <span className="sr-only"> — {t.scoreSpoken({ mean: formatMean(rollup.value, locale), max: formatNumber(max, locale) })}</span></span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className="text-muted-foreground text-sm tabular-nums">{t.ratingCount(ratings)}</span>
        </p>
        : rollup.valueWithheld ? <p className="font-medium text-sm">{t.combinedWithheld({ unit: noun })}</p>
          : <p className="text-muted-foreground text-sm">{ratings ? t.ratingCount(ratings) : t.combinedNone}</p>}
      <p className="text-muted-foreground text-sm">
        {t.coverage({ met: formatNumber(rollup.coverage.meetingThreshold, locale), total: formatNumber(rollup.coverage.members, locale), unit: noun })}</p>
    </div>
    <ol className="grid gap-2">
      {available.map(member => {
        const read = byTarget.get(member.target);
        const figures = figuresOfMember(member, rollup.displayThreshold, max);
        return <li key={member.target} data-rollup-member={member.target}
          className={cn('grid gap-2 rounded-xl border border-border/60 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] sm:items-center')}>
          <FrameChips chips={frameChips(read?.summary ?? undefined, locale)} label={t.within} />
          {figures ? <ScoreFigure figures={figures} locale={locale} messages={messages} /> : null}
        </li>;
      })}
    </ol>
    {notAccepted > 0 ? <p className="text-muted-foreground text-sm">{t.notCounted(notAccepted)}</p> : null}
    {unreadable > 0 ? <p className="text-muted-foreground text-sm">{t.unreadable(unreadable)}</p> : null}
  </>;
}

/**
 * The places of a subject (its episodes, chapters, matches or maps) as a list of their own figures, with a combined score
 * that says how it was combined and how many of the places it could count. Pooling and averaging the places can rank two
 * subjects in opposite order, so neither is the quiet default: the formula and the coverage always travel with the value,
 * and the value is withheld where fewer than half of the places have enough ratings.
 */
export function FrameRollup({ subject, question, unit, api, members, include, defaultFormula = 'pooled', locale, messages, className }: {
  subject: string; question: Question; unit: RollupUnit; api: ScopedRatingApi;
  /** Places the host already read; otherwise this reads the subject's places. */
  members?: readonly ProjectionRead[];
  /** Which of the subject's places are members, such as only its episodes. */
  include?: (read: ProjectionRead) => boolean;
  defaultFormula?: RollupFormula; locale: UiLocale; messages: ScopedRatingMessages; className?: string;
}) {
  const t = translate(messages, locale);
  const [all, reload] = useLoad(async () => members ? { ok: true as const, data: [...members] } : readAllProjections(api, subject), subject);
  if (all.state === 'loading') return <p className={cn('text-muted-foreground text-sm', className)} aria-busy="true">{t.loading}</p>;
  if (all.state === 'failed') return <FailureNote failure={all.failure} locale={locale} messages={messages} retry={reload} className={className} />;
  // A place the reader has not reached is not a member they can see: its name and number could spoil the story.
  const visible = all.data.filter(read => read.summary?.status === 'available' && (include?.(read) ?? true));
  if (!visible.length) return <p className={cn('rounded-2xl bg-muted/60 px-4 py-3 text-sm', className)}>{t.noParts}</p>;
  return <div className={className}>
    <RollupView members={visible} question={question} unit={unit} api={api} defaultFormula={defaultFormula} locale={locale} messages={messages} />
  </div>;
}
