import { createContext, useContext, useState, type ContextType, type ReactNode } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { MetaLine } from '@rezics/ui/meta-line';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { useSearchRetryWait } from '../../search/search-recovery-retry';
import { SubjectRatingControl } from './rating-control';
import type { SubjectOwnRating } from './subject-ratings';
import type { SubjectPersonalLease } from './subject-personal-reader';
import {
  displayRating,
  GLOBAL,
  PUBLIC_RATING_SCALE,
  providerStatisticLabel,
  suppliedRatingSources,
  type Figure,
  type Ratings,
  type RatingSources,
  type RatingSource,
  type RatingOutcome,
} from './subject-ratings';
import { admitRatingRetry } from './rating-retry-admission';
import { PublicRatingFigure } from './public-rating-figure';
import { RatingDistribution } from './rating-distribution';
import { OverviewContext, viewHref } from './overview';
import { useRatingSourceRetryFocus, type RatingRetryOwner } from './subject-rating-retry-focus';
import {
  ClassificationAssessmentHandlerContext,
  ClassificationAssessmentChromeContext,
  ClassificationAssessmentSection,
} from './subject-classification-assessment-view';
import { subjectHref } from '../../subject/subject-href';

const sectionClass = 'min-w-0 space-y-4 in-data-[density=compact]:space-y-3';
const headingClass =
  'text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl';
const summaryClass =
  'list-item list-inside min-h-11 min-w-11 max-w-full cursor-pointer rounded-sm px-2 py-3 text-start text-sm font-medium whitespace-normal wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm px-2 py-3 text-start text-sm font-medium whitespace-normal wrap-anywhere text-primary underline underline-offset-4 hover:text-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export const RatingsContext = createContext<Ratings | RatingSources | null | undefined>(undefined);
/** Story fixtures can show each display state without adding another request to the subject page. */
export const RatingsPreviewContext = createContext<Ratings | RatingSources | null | undefined>(undefined);
export const RatingsRecoveryContext = createContext<((source: RatingSource) => void) | null>(null);
export const RatingPopulationsContext = createContext<ReactNode>(null);

export type RatingSourceOwner = Omit<RatingRetryOwner, 'locale' | 'source'>;

/** A source-local recovery never invalidates a sibling or submits the personal vote. */
export function RatingSourceStatus({
  outcome,
  source,
  locale,
  retry,
  owner,
  children,
}: {
  outcome: RatingOutcome<unknown>;
  source: string;
  locale: string;
  retry?: (() => void) | undefined;
  owner?: RatingSourceOwner | undefined;
  children?: ReactNode;
}) {
  const options = { locale: locales.find((item) => item === locale) ?? 'en' };
  const labels: Record<string, string> = {
    question: m.rating_population_source_question({}, options),
    figure: m.rating_population_source_figure({}, options),
    global: m.rating_population_source_global({}, options),
    statistics: m.rating_population_source_statistics({}, options),
    directory: m.rating_population_source_directory({}, options),
    selected: m.rating_population_source_selected({}, options),
    comparison: m.rating_population_source_comparison({}, options),
  };
  const label = labels[source] ?? m.rating_population_source_comparison({}, options);
  const focus = useRatingSourceRetryFocus(
    {
      subject: owner?.subject ?? '',
      locale,
      source,
      ...(owner?.population !== undefined ? { population: owner.population } : {}),
      ...(owner?.incarnation !== undefined ? { incarnation: owner.incarnation } : {}),
      ...(owner?.isCurrent !== undefined ? { isCurrent: owner.isCurrent } : {}),
    },
    outcome.kind,
  );
  const retryAfter = outcome.kind === 'failed' ? outcome.retryAfter : undefined;
  const retryAt = outcome.kind === 'failed' ? outcome.retryAt : undefined;
  const waiting = useSearchRetryWait(retryAt);
  if (outcome.kind === 'ready' && children == null) return null;
  return (
    <div
      ref={focus.targetRef}
      role="group"
      aria-label={label}
      tabIndex={-1}
      data-slot="rating-source-status"
      data-source={source}
      data-state={outcome.kind}
      data-retry-after={retryAfter}
      className="space-y-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {outcome.kind === 'ready' ? (
        children
      ) : (
        <>
          <p className="font-medium">{label}</p>
          <p role="status">
            {outcome.kind === 'idle'
              ? m.rating_population_loading({}, options)
              : outcome.kind === 'absent'
                ? m.rating_population_absent({}, options)
                : outcome.kind === 'terminal'
                  ? m.rating_population_terminal({}, options)
                  : outcome.kind === 'unavailable'
                    ? m.rating_population_unavailable({}, options)
                    : m.rating_population_failed({}, options)}
          </p>
          {waiting && <p role="status">{m.search_recovery_wait({}, options)}</p>}
          {retry && outcome.kind !== 'terminal' && outcome.kind !== 'idle' && (
            <Button
              ref={focus.retryRef}
              type="button"
              variant="outline"
              aria-disabled={waiting || undefined}
              className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={(event) => {
                focus.noteActivation(event.currentTarget);
                if (waiting || !admitRatingRetry(retryAt)) return;
                retry();
              }}
            >
              {m.subject_section_retry({}, options)}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export const RatingControlContext = createContext<{
  subjectId: string;
  locale: string;
  returnTo: string;
  session: 'unknown' | 'unavailable' | 'signed-out' | 'signed-in';
  own: SubjectOwnRating | undefined;
  binding?: SubjectPersonalLease;
  failure?: boolean;
} | null>(null);

/** Only the admitted page identity supplies navigation; source retries keep their own callbacks. */
function useRatingNavigation(subject: string, locale: string) {
  const page = useContext(OverviewContext);
  if (page) {
    return {
      reviewsHref: viewHref(page, 'reviews') ?? undefined,
      retryHref: viewHref(page, page.pageTarget?.view ?? 'overview') ?? undefined,
    };
  }
  // Standalone previews have no page address or selected Realm.
  const base = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject)}`;
  return { reviewsHref: `${base}/reviews`, retryHref: base };
}

function RatingsFailure({ id, subject, locale }: { id: string; subject: string; locale: string }) {
  const options = { locale: locale as never };
  const { reviewsHref, retryHref } = useRatingNavigation(subject, locale);
  return (
    <section data-slot="rating-summary" data-state="failed" aria-labelledby={`${id}-title`} className={sectionClass}>
      <h2 id={`${id}-title`} className={headingClass}>
        {m.subject_ratings({}, options)}
      </h2>
      <p role="status" className="text-sm text-muted-foreground">
        {m.subject_section_failed({}, options)}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <a data-slot="retry" href={retryHref} className={linkClass}>
          {m.subject_section_retry({}, options)}
        </a>
        <a data-slot="see-reviews" href={reviewsHref} className={linkClass}>
          {m.subject_ratings_reviews({}, options)}
        </a>
      </div>
    </section>
  );
}

export function RatingsSection({ id, subject, locale }: { id: string; subject: string; locale: string }) {
  const routeData = useContext(RatingsContext);
  const previewData = useContext(RatingsPreviewContext);
  const control = useContext(RatingControlContext);
  const data = previewData === undefined ? routeData : previewData;

  if (data === null) return <RatingsFailure id={id} subject={subject} locale={locale} />;
  if (data === undefined) return null;

  return <RatingsView data={data} id={id} subject={subject} locale={locale} control={control} />;
}

export function RatingsView({
  data,
  id,
  subject,
  locale,
  control,
}: {
  data: Ratings | RatingSources | null;
  id: string;
  subject: string;
  locale: string;
  control?: ContextType<typeof RatingControlContext>;
}) {
  const options = { locale: locale as never };
  const recovery = useContext(RatingsRecoveryContext);
  const populations = useContext(RatingPopulationsContext);
  const assessmentHandlers = useContext(ClassificationAssessmentHandlerContext);
  const assessmentChrome = useContext(ClassificationAssessmentChromeContext);
  const page = useContext(OverviewContext);
  const title = m.subject_ratings({}, options);
  const { reviewsHref } = useRatingNavigation(subject, locale);
  if (!data) return <RatingsFailure id={id} subject={subject} locale={locale} />;
  const supplied = 'figures' in data ? data : undefined;
  const sources = 'figures' in data ? suppliedRatingSources(data) : data;
  const question = sources.question.kind === 'ready' ? sources.question.value : undefined;
  const headline = sources.figure.kind === 'ready' ? sources.figure.value : undefined;
  const statistics = sources.statistics.kind === 'ready' ? sources.statistics.value : [];
  const owner = { subject };
  const status = (source: RatingSource, result?: ReactNode) => (
    <RatingSourceStatus
      outcome={sources[source]}
      source={source}
      locale={locale}
      retry={
        recovery
          ? () => {
              const outcome = sources[source];
              if (!admitRatingRetry(outcome.kind === 'failed' ? outcome.retryAt : undefined)) return;
              recovery(source);
            }
          : undefined
      }
      owner={owner}
    >
      {result}
    </RatingSourceStatus>
  );

  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  const date = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime())
      ? new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(
          parsed,
        )
      : value;
  };

  const globalFigure = sources.global.kind === 'ready' ? sources.global.value : undefined;
  const threshold = question && ['episode', 'character'].includes(question.grain) ? 10 : 5;

  return (
    <section data-slot="rating-summary" aria-labelledby={`${id}-title`} className={sectionClass}>
      <h2 id={`${id}-title`} className={headingClass}>
        {title}
      </h2>
      {status(
        'question',
        question ? (
          <p
            className="text-sm font-medium wrap-anywhere"
            data-slot="rating-question"
            data-revision={question.revision}
          >
            {question.label}
          </p>
        ) : undefined,
      )}
      <div data-slot="rating-figures" className="space-y-4">
        <div className="space-y-2 [&_strong]:text-3xl [&_strong]:font-semibold">
          {status(
            'figure',
            headline ? (
              <>
                <PublicRatingFigure
                  figure={headline}
                  locale={locale}
                  {...(question ? { remaining: threshold - headline.count } : {})}
                />
                {headline.count === 0 && headline.state !== 'updating' && (
                  <p className="text-sm text-muted-foreground">{m.subject_ratings_empty({}, options)}</p>
                )}
              </>
            ) : undefined,
          )}
        </div>
        {!control && supplied && supplied.own !== null && question && (
          <p data-slot="own-rating" className="text-sm text-muted-foreground">
            {m.subject_ratings_yours({ score: number(displayRating(supplied.own!, question.scale), 2) }, options)}
          </p>
        )}
        {control && question && (
          <SubjectRatingControl
            {...(control.failure !== undefined ? { initialFailure: control.failure } : {})}
            question={question}
            locale={control.locale}
            own={control.own}
            {...(control.binding ? { binding: control.binding } : {})}
            returnTo={control.returnTo}
            session={control.session}
            subjectId={control.subjectId}
          />
        )}
      </div>
      <p data-slot="rating-global" className="text-sm font-medium">
        {m.rating_population_source_global({}, options)}
      </p>
      {status(
        'global',
        !headline && globalFigure && question ? (
          <div data-slot="rating-global-aggregate" className="space-y-1 text-sm">
            {globalFigure.freshness?.updating ? (
              <p role="status">{m.rating_public_updating({}, options)}</p>
            ) : globalFigure.count === 0 ? (
              <p>{m.subject_ratings_empty({}, options)}</p>
            ) : (
              <>
                <p>
                  {m.subject_ratings_realm_count(
                    { count: number(globalFigure.count), population: m.rating_population_source_global({}, options) },
                    options,
                  )}
                </p>
                {globalFigure.remaining !== undefined || globalFigure.count < threshold ? (
                  <p>
                    {m.subject_ratings_remaining(
                      { count: number(globalFigure.remaining ?? threshold - globalFigure.count) },
                      options,
                    )}
                  </p>
                ) : globalFigure.mean !== undefined &&
                  Number.isFinite(globalFigure.mean) &&
                  globalFigure.mean >= question.scale.min &&
                  globalFigure.mean <= question.scale.max &&
                  question.scale.max > question.scale.min ? (
                  <p>
                    {m.rating_public_mean(
                      {
                        mean: number(displayRating(globalFigure.mean, question.scale), 2),
                        maximum: number(PUBLIC_RATING_SCALE.max),
                      },
                      options,
                    )}
                  </p>
                ) : (
                  <p>{m.subject_ratings_figure_unavailable({}, options)}</p>
                )}
              </>
            )}
          </div>
        ) : undefined,
      )}
      {question && <RatingDistribution figure={globalFigure} headline={headline} question={question} locale={locale} />}
      {populations}
      {supplied && (
        <RatingComparisons
          key={`${subject}:${supplied.question.id}:${supplied.question.revision}`}
          data={supplied}
          id={id}
          locale={locale}
        />
      )}
      <details data-slot="rating-provenance" className="text-sm">
        <summary className={summaryClass}>{m.subject_ratings_provenance({}, options)}</summary>
        <div className="mt-3 space-y-3 wrap-anywhere text-muted-foreground">
          {question && (
            <p data-slot="rating-question-revision">
              {m.rating_question_revision({ revision: number(question.revision) }, options)}
            </p>
          )}
          <p>{m.rating_public_delay({}, options)}</p>
          <p>{m.rating_public_ordering({}, options)}</p>
          {status(
            'statistics',
            statistics.length
              ? statistics.map((item) => (
                  <p
                    key={`${item.source}:${item.sourceRecordId ?? ''}`}
                    data-slot="imported-score"
                    data-provider={item.source}
                    className="min-w-0 break-words"
                  >
                    <MetaLine
                      items={[
                        <span className="font-medium">{providerStatisticLabel(item.source)}</span>,
                        <strong className="tabular-nums">
                          {number(item.mean, 2)} ({number(item.scale.min)}–{number(item.scale.max)})
                        </strong>,
                        m.subject_ratings_imported({ count: number(item.count), date: date(item.asOf) }, options),
                        item.sourceRecordId
                          ? m.subject_classification_source_record({ record: item.sourceRecordId }, options)
                          : null,
                        item.sourceAlias && item.sourceAlias !== item.source
                          ? m.subject_classification_source_alias({ alias: item.sourceAlias }, options)
                          : null,
                        item.observation
                          ? m.subject_classification_source_unversioned(
                              { digest: item.observation.digest.slice(0, 12) },
                              options,
                            )
                          : null,
                        item.licence ? m.rating_import_licence({ licence: item.licence }, options) : null,
                        item.attribution
                          ? m.rating_import_attribution({ attribution: item.attribution }, options)
                          : null,
                      ]}
                    />
                  </p>
                ))
              : undefined,
          )}
        </div>
      </details>
      {assessmentHandlers && assessmentChrome && control && (
        <ClassificationAssessmentSection
          locale={locale}
          title={assessmentChrome.title || page?.subjectLabel || title}
          returnTo={assessmentChrome.returnTo}
          csrfToken={assessmentChrome.csrfToken}
          statistics={statistics}
          sourcesHref={`${subjectHref({ id: subject, label: assessmentChrome.title || page?.subjectLabel || title }, locale).href}/sources`}
          session={control.session}
          handlers={assessmentHandlers}
        />
      )}
      <a data-slot="see-reviews" className={linkClass} href={reviewsHref}>
        {m.subject_ratings_reviews({}, options)}
      </a>
    </section>
  );
}

/** Select at most five leading comparisons in O(R); do not sort or discover all populations. */
function RatingComparisons({ data, id, locale }: { data: Ratings; id: string; locale: string }) {
  const [expanded, setExpanded] = useState(false);
  const options = { locale: locale as never };
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  const figures = new Map(data.figures.map((item) => [item.population, item]));
  const seen = new Set([GLOBAL]);
  const comparisons = data.realms
    .filter((realm) => {
      if (seen.has(realm.id)) return false;
      seen.add(realm.id);
      return true;
    })
    .map((realm) => ({ realm, figure: figures.get(realm.id) }));
  type Comparison = (typeof comparisons)[number];
  const initial: Comparison[] = [];
  for (const item of comparisons) {
    const rank = (value: Comparison) => value.figure?.count ?? -1;
    const position = initial.findIndex((candidate) => rank(item) > rank(candidate));
    initial.splice(position < 0 ? initial.length : position, 0, item);
    if (initial.length > 5) initial.pop();
  }
  if (comparisons.length === 0) return null;
  const selected = new Set(initial.map(({ realm }) => realm.id));
  const remaining = comparisons.filter(({ realm }) => !selected.has(realm.id));
  const figure = (item: Figure | undefined, label: string) => {
    if (!item || !Number.isSafeInteger(item.count) || item.count < 0)
      return <p>{m.subject_ratings_figure_unavailable({}, options)}</p>;
    if (item.freshness?.updating)
      return (
        <div>
          <p>{m.subject_ratings_realm_count({ count: number(item.count), population: label }, options)}</p>
          <p role="status" className="text-muted-foreground">
            {m.rating_public_updating({}, options)}
          </p>
        </div>
      );
    if (item.count === 0) return <p>{m.subject_ratings_empty({}, options)}</p>;
    return (
      <div className="space-y-1">
        <p>{m.subject_ratings_realm_count({ count: number(item.count), population: label }, options)}</p>
        {item.remaining !== undefined ? (
          <p className="text-muted-foreground">
            {m.subject_ratings_remaining({ count: number(item.remaining) }, options)}
          </p>
        ) : item.mean !== undefined && Number.isFinite(item.mean) ? (
          <p className="font-medium tabular-nums">
            {m.rating_public_mean(
              {
                mean: number(displayRating(item.mean, data.question.scale), 2),
                maximum: number(PUBLIC_RATING_SCALE.max),
              },
              options,
            )}
          </p>
        ) : (
          <p className="text-muted-foreground">{m.subject_ratings_figure_unavailable({}, options)}</p>
        )}
      </div>
    );
  };
  const rows = (items: Comparison[]) =>
    items.map(({ realm, figure: item }) => (
      <li key={realm.id} data-slot="rating-comparison" className="min-w-0">
        <ContentItemFrame
          as="div"
          data-slot="content-item-frame"
          className="min-w-0 space-y-2 wrap-anywhere py-3 sm:py-4"
        >
          <ContentItemHeading level={3} className="text-[17px] leading-snug font-semibold sm:text-lg md:text-xl">
            {realm.name}
          </ContentItemHeading>
          <div data-content-item-slot="preview">{figure(item, realm.name)}</div>
        </ContentItemFrame>
      </li>
    ));
  return (
    <details data-slot="rating-comparisons" className="text-sm">
      <summary className={summaryClass}>{m.subject_ratings_comparisons({}, options)}</summary>
      <ul className="mt-3 grid gap-4 sm:grid-cols-2">{rows(initial)}</ul>
      {remaining.length > 0 && (
        <>
          <ul id={`${id}-more-comparisons`} hidden={!expanded} className="mt-4 grid gap-4 sm:grid-cols-2">
            {expanded && rows(remaining)}
          </ul>
          <Button
            type="button"
            variant="link"
            aria-expanded={expanded}
            aria-controls={`${id}-more-comparisons`}
            className="mt-3 h-auto min-h-11 min-w-11 max-w-full justify-start whitespace-normal wrap-anywhere px-2 py-3 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? m.subject_ratings_fewer_comparisons({}, options)
              : m.subject_ratings_more_comparisons({ count: number(remaining.length) }, options)}
          </Button>
        </>
      )}
    </details>
  );
}
