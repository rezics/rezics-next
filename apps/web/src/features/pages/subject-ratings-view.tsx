import { createContext, useContext, useState, type ContextType } from 'react';
import { MetaLine } from '@rezics/ui/meta-line';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { SubjectRatingControl } from './rating-control';
import type { SubjectOwnRating } from './subject-ratings';
import { displayRating, GLOBAL, PUBLIC_RATING_SCALE, type Figure, type Ratings } from './subject-ratings';
import { PublicRatingFigure } from './public-rating-figure';
import { RatingDistribution } from './rating-distribution';

const sectionClass = 'min-w-0 space-y-4 in-data-[density=compact]:space-y-3';
const headingClass =
  'text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl';
const linkClass = 'text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80';

export const RatingsContext = createContext<Ratings | null | undefined>(undefined);
/** Story fixtures can show each display state without adding another request to the subject page. */
export const RatingsPreviewContext = createContext<Ratings | null | undefined>(undefined);
export const RatingControlContext = createContext<{
  subjectId: string;
  locale: string;
  returnTo: string;
  session: 'unknown' | 'unavailable' | 'signed-out' | 'signed-in';
  own: SubjectOwnRating | undefined;
  failure?: boolean;
} | null>(null);

function RatingsFailure({ id, subject, locale }: { id: string; subject: string; locale: string }) {
  const options = { locale: locale as never };
  const reviewsHref = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject)}/reviews`;
  return (
    <section data-slot="rating-summary" data-state="failed" aria-labelledby={`${id}-title`} className={sectionClass}>
      <h2 id={`${id}-title`} className={headingClass}>
        {m.subject_ratings({}, options)}
      </h2>
      <p role="status" className="text-sm text-muted-foreground">
        {m.subject_section_failed({}, options)}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <a data-slot="retry" href="?" className={linkClass}>
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
  data: Ratings | null;
  id: string;
  subject: string;
  locale: string;
  control?: ContextType<typeof RatingControlContext>;
}) {
  const options = { locale: locale as never };
  const title = m.subject_ratings({}, options);
  const reviewsHref = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject)}/reviews`;

  if (!data) return <RatingsFailure id={id} subject={subject} locale={locale} />;

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

  const globalFigure = data.figures.find((item) => item.population === GLOBAL);
  const threshold = ['episode', 'character'].includes(data.question.grain) ? 10 : 5;

  return (
    <section data-slot="rating-summary" aria-labelledby={`${id}-title`} className={sectionClass}>
      <h2 id={`${id}-title`} className={headingClass}>
        {title}
      </h2>
      <p className="text-sm font-medium" data-slot="rating-question" data-revision={data.question.revision}>
        {data.question.label}
        <span className="ml-2 text-muted-foreground">
          {m.rating_question_revision({ revision: number(data.question.revision) }, options)}
        </span>
      </p>
      <div data-slot="rating-figures" className="space-y-4">
        <div className="space-y-2 [&_strong]:text-3xl [&_strong]:font-semibold">
          <PublicRatingFigure figure={data.figure} locale={locale} remaining={threshold - data.figure.count} />
          {data.figure.count === 0 && data.figure.state !== 'updating' && (
            <p className="text-sm text-muted-foreground">{m.subject_ratings_empty({}, options)}</p>
          )}
        </div>
        {!control && data.own !== null && (
          <p data-slot="own-rating" className="text-sm text-muted-foreground">
            {m.subject_ratings_yours({ score: number(displayRating(data.own, data.question.scale), 2) }, options)}
          </p>
        )}
        {control && (
          <SubjectRatingControl
            {...(control.failure !== undefined ? { initialFailure: control.failure } : {})}
            question={data.question}
            locale={control.locale}
            own={control.own}
            returnTo={control.returnTo}
            session={control.session}
            subjectId={control.subjectId}
          />
        )}
      </div>
      <RatingDistribution figure={globalFigure} headline={data.figure} question={data.question} locale={locale} />
      <RatingComparisons
        key={`${subject}:${data.question.id}:${data.question.revision}`}
        data={data}
        id={id}
        locale={locale}
      />
      <details data-slot="rating-provenance" className="text-sm">
        <summary className="cursor-pointer font-medium">{m.subject_ratings_provenance({}, options)}</summary>
        <div className="mt-3 space-y-3 text-muted-foreground">
          <p>{m.rating_public_delay({}, options)}</p>
          <p>{m.rating_public_ordering({}, options)}</p>
          {data.statistics.map((item) => (
            <p key={item.source} data-slot="imported-score" className="min-w-0 break-words">
              <MetaLine
                items={[
                  <span className="font-medium">{item.source === 'vndb' ? 'VNDB' : item.source}</span>,
                  <strong className="tabular-nums">
                    {number(item.mean, 2)} ({number(item.scale.min)}–{number(item.scale.max)})
                  </strong>,
                  m.subject_ratings_imported({ count: number(item.count), date: date(item.asOf) }, options),
                  item.licence ? m.rating_import_licence({ licence: item.licence }, options) : null,
                  item.attribution ? m.rating_import_attribution({ attribution: item.attribution }, options) : null,
                ]}
              />
            </p>
          ))}
        </div>
      </details>
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
      <li key={realm.id} data-slot="rating-comparison" className="min-w-0 space-y-1 break-words">
        <h3 className="font-medium">{realm.name}</h3>
        {figure(item, realm.name)}
      </li>
    ));
  return (
    <details data-slot="rating-comparisons" className="text-sm">
      <summary className="cursor-pointer font-medium">{m.subject_ratings_comparisons({}, options)}</summary>
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
            className="mt-3 h-auto max-w-full whitespace-normal p-0 text-start"
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
