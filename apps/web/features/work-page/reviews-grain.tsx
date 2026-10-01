'use client';

import { cn } from '@rezics/ui/utils';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { failureOf } from './failure.ts';
import type { WorkPageMessages } from './messages.ts';
import { aggregateOf, type ReviewAggregate, type ReviewGrain, type ReviewScopeQuery, type ReviewTarget }
  from './reviews-grain-model.tsx';
import type { Loaded, ReadFailure, ReviewPage } from './types.ts';

type Translation = ReturnType<typeof materializeData<WorkPageMessages>>;

/** What reading another target's reviews found: its question, scale, aggregate and first page, or why there are none. */
export type GrainRead =
  | { kind: 'ready'; context: string; scale: number; aggregate: ReviewAggregate | null; reviews: Loaded<ReviewPage> }
  /** Main lists no rating question for the target in this scope: nothing is asked of readers, so nothing is reviewed. */
  | { kind: 'no-question' }
  | { kind: 'failed'; failure: ReadFailure };

const idOf = (iri: string) => iri.slice(-36);

/**
 * Reads one target's reviews the way the page reads the Work's own: the rating question Main lists for it in the
 * page's scope (never picked for the reader when there are several, the first is shown), the aggregate that
 * question gives, and its first page of reviews. A target the scope has no question for is `no-question`.
 */
export async function readGrain(target: string, scope: ReviewScopeQuery, actingSubject: string | null): Promise<GrainRead> {
  try {
    const resource = browserMainApi().v1.resources({ resource: idOf(target) });
    const reader = actingSubject ? { actingSubject } : {};
    const contexts = await resource['rating-contexts'].get({ query: { ...scope, ...reader } });
    if (contexts.error) return { kind: 'failed', failure: failureOf(contexts.error.status) };
    const question = contexts.data?.items[0];
    if (!question) return { kind: 'no-question' };
    const [ratings, reviews] = await Promise.all([
      resource.ratings.get({ query: { ...scope, ...reader, context: question.context } }),
      resource.reviews.get({ query: { context: question.context, sort: 'helpful', limit: 10, ...reader } }),
    ]);
    if (ratings.error) return { kind: 'failed', failure: failureOf(ratings.error.status) };
    return { kind: 'ready', context: question.context, scale: question.scale.max,
      aggregate: ratings.data ? aggregateOf(ratings.data) : null,
      reviews: reviews.error ? { ok: false, failure: failureOf(reviews.error.status) }
        : reviews.data ? { ok: true, data: reviews.data } : { ok: false, failure: 'unavailable' } };
  } catch {
    return { kind: 'failed', failure: 'unavailable' };
  }
}

const groups: { grain: ReviewGrain; label: (t: Translation) => string }[] = [
  { grain: 'story', label: t => t.grainStory }, { grain: 'edition', label: t => t.grainEdition },
  { grain: 'translation', label: t => t.grainTranslation }, { grain: 'related', label: t => t.grainRelated },
];

/**
 * What the reviews are of: the story, each edition, each translation and each related Work. Which is shown is the
 * reader's choice and stays visible, since an edition's reviews are not the story's.
 */
export function GrainChooser({ targets, selected, onSelect, t }: {
  targets: readonly ReviewTarget[]; selected: string; onSelect: (target: ReviewTarget) => void; t: Translation;
}) {
  return <nav aria-label={t.reviewGrains} data-review-grains className="grid gap-2 text-sm">
    {groups.map(({ grain, label }) => {
      const options = targets.filter(target => target.grain === grain);
      if (!options.length) return null;
      return <div key={grain} role="group" aria-label={label(t)} data-review-grain={grain}
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground text-xs">{label(t)}</span>
        {options.map(option => <button key={option.target} type="button" aria-pressed={option.target === selected}
          lang={option.language} onClick={() => onSelect(option)} data-review-target={idOf(option.target)}
          className={cn('h-8 max-w-full truncate rounded-full border border-border/70 px-3 font-medium',
            'text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2',
            'focus-visible:ring-ring aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background')}>
          {option.label}</button>)}
      </div>;
    })}
  </nav>;
}

const grainNames = (t: Translation): Record<string, string> => ({ 'main-version': t.grainNameMainVersion,
  release: t.grainNameRelease, realization: t.grainNameRealization, occurrence: t.grainNameOccurrence,
  resource: t.grainNameResource });
const populationNames = (t: Translation): Record<string, string> => ({ 'account-principal': t.populationAccount,
  'global-account-principal': t.populationGlobalAccount, 'reader-account-principal': t.populationReaderAccount });

/**
 * The scope of the aggregate shown, as Main states it: which question, counted per what, whose ratings, how many and
 * their mean. The values Main gave are also on the element, so nothing here is a word of the page's own.
 */
export function AggregateScope({ aggregate, locale, t }: { aggregate: ReviewAggregate | null; locale: UiLocale; t: Translation }): ReactNode {
  if (!aggregate) return null;
  const mean = aggregate.mean === null ? null : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(aggregate.mean);
  return <p data-review-aggregate data-aggregate-grain={aggregate.grain} data-aggregate-population={aggregate.population}
    data-aggregate-counted={idOf(aggregate.countedTarget)} data-aggregate-count={aggregate.count}
    className="flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground text-sm">
    <span lang="en">{aggregate.question}</span><span aria-hidden="true">·</span>
    <span>{t.aggregateGrain({ grain: grainNames(t)[aggregate.grain] ?? aggregate.grain })}</span>
    <span aria-hidden="true">·</span>
    <span>{t.ratingPopulation({ who: populationNames(t)[aggregate.population] ?? aggregate.population })}</span>
    <span aria-hidden="true">·</span><span>{aggregate.count ? t.ratingCount(aggregate.count) : t.aggregateNone}</span>
    {mean ? <><span aria-hidden="true">·</span>
      <span>{t.aggregateMean({ mean, max: String(aggregate.scale?.max ?? '') })}</span></> : null}
  </p>;
}
