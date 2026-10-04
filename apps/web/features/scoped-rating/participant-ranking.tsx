'use client';

import { LocalizedText } from '@rezics/ui/localized-text';
import { cn } from '@rezics/ui/utils';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import type { ProjectionRead, ScopedRatingApi } from './api.ts';
import { FailureNote } from './failure.tsx';
import { formatMean, formatNumber, translate } from './format.ts';
import { subjectOf } from './frames.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { SubjectAvatar } from './projection-header.tsx';
import { questionText } from './question-rating.tsx';
import type { Question, Rollup } from './types.ts';
import { useLoad } from './use-load.ts';

function Participant({ read, locale }: { read: ProjectionRead | undefined; locale: UiLocale }) {
  const who = subjectOf(read?.summary ?? undefined, locale);
  if (!who) return null;
  return <span className="flex min-w-0 items-center gap-2.5">
    <SubjectAvatar avatar={who.avatar} name={who.name.value} className="size-9 sm:size-9" />
    <Link href={who.href} className="min-w-0 truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
      <LocalizedText text={who.name} /></Link>
  </span>;
}

/**
 * The participants of an event ranked by the published weighted rating, with why: the minimum number of ratings a
 * participant needs, the overall average everyone's score is pulled toward until they have it, and how far each
 * unranked participant has come. A participant the reader cannot see is not listed, and the ranking never shows an
 * order Main did not publish.
 */
export function ParticipantRanking({ question, participants, api, level = 2, locale, messages, className }: {
  question: Question;
  /** Each participant's place within the event, such as a player's projection for the match. */
  participants: readonly ProjectionRead[]; api: ScopedRatingApi; level?: 2 | 3; locale: UiLocale;
  messages: ScopedRatingMessages; className?: string;
}) {
  const t = translate(messages, locale);
  const Heading = `h${level}` as const;
  const SubHeading = `h${level + 1}` as 'h3' | 'h4';
  const visible = participants.filter(read => read.summary?.status === 'available');
  const targets = visible.map(read => read.projection.id);
  const [result, reload] = useLoad<Rollup | null>(async () => targets.length ? api.rollup(question.context, targets, 'pooled', true)
    : { ok: true, data: null }, `${question.context}\n${targets.join()}`);
  const byTarget = new Map(visible.map(read => [read.projection.id, read]));
  const text = questionText(question);
  const rank = result.state === 'ready' ? result.data?.rank ?? null : null;
  const max = result.state === 'ready' ? result.data?.scale.max ?? 10 : 10;
  const ranked = new Set(rank?.items.map(item => item.target));
  const waiting = result.state === 'ready' && result.data
    ? result.data.members.flatMap(member => member.status === 'available' && !ranked.has(member.target)
      ? [{ target: member.target, count: member.components.count }] : []) : [];
  return <section data-ranking className={cn('grid gap-4', className)}>
    <div className="grid gap-1">
      <Heading className="font-semibold text-lg tracking-tight">{t.ranking}</Heading>
      <p lang={text.language} dir={text.direction} className="text-muted-foreground text-sm">{text.value}</p>
    </div>
    {result.state === 'loading' ? <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>
      : result.state === 'failed' ? <FailureNote failure={result.failure} locale={locale} messages={messages} retry={reload} />
        : <>
          <div className="grid gap-1 text-muted-foreground text-sm">
            <p>{t.rankingBasis}</p>
            <p data-ranking-eligibility>
              {t.rankingEligibility({ min: formatNumber(rank?.minimumRatings ?? 50, locale) })}
              {rank?.prior ? ` ${t.rankingPrior({ mean: formatMean(rank.prior.mean, locale), ratings: t.ratingCount(rank.prior.ratings) })}` : ''}
            </p>
          </div>
          {rank?.status === 'unavailable' || !rank?.items.length
            ? <p className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">{rank?.status === 'unavailable' && !waiting.length ? t.rankingUnavailable : t.rankingNone}</p>
            : <ol className="grid gap-2">
              {rank.items.map(item => <li key={item.target} data-rank={item.position}
                className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
                <span className="font-semibold text-muted-foreground text-sm tabular-nums">{t.rankingPlace({ position: formatNumber(item.position, locale) })}</span>
                <Participant read={byTarget.get(item.target)} locale={locale} />
                <span className="col-span-2 flex flex-wrap items-baseline gap-x-2 text-sm sm:col-span-1 sm:justify-end">
                  <span className="font-semibold tabular-nums">{t.rankingWeighted({ score: formatMean(item.score, locale) })}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {t.score({ mean: formatMean(item.mean, locale), max: formatNumber(max, locale) })} · {t.ratingCount(item.count)}</span>
                </span>
              </li>)}
            </ol>}
          {waiting.length ? <div className="grid gap-2">
            <SubHeading className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{t.rankingWaiting}</SubHeading>
            <ul className="grid gap-1.5">
              {waiting.map(entry => <li key={entry.target} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                <Participant read={byTarget.get(entry.target)} locale={locale} />
                <span className="text-muted-foreground tabular-nums">
                  {t.rankingProgress({ count: formatNumber(entry.count, locale), min: formatNumber(rank?.minimumRatings ?? 50, locale) })}</span>
              </li>)}
            </ul>
          </div> : null}
        </>}
  </section>;
}
