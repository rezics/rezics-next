import { createContext, useContext, type ContextType } from 'react';
import { MetaLine } from '@rezics/ui/meta-line';
import { m } from '../../paraglide/messages.js';
import { SubjectRatingControl } from './rating-control';
import type { SubjectOwnRating } from './subject-ratings';
import {
  displayRating,
  hasPublicMean,
  GLOBAL,
  PUBLIC_RATING_SCALE,
  type Figure,
  type Ratings,
} from './subject-ratings';
import { PublicRatingFigure } from './public-rating-figure';

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

  const figure = (item: Figure | undefined, label: string) => {
    if (!item || item.count === 0)
      return (
        <p>
          <MetaLine items={[<span className="font-medium">{label}</span>, m.subject_ratings_empty({}, options)]} />
        </p>
      );

    const count = number(item.count);
    const countLabel = m.subject_ratings_realm_count({ count, population: label }, options);
    const mean = item.remaining === undefined ? item.mean : undefined;

    return (
      <div>
        <p>
          <MetaLine
            items={[
              mean !== undefined ? (
                <strong className="text-xl tabular-nums">
                  {m.rating_public_mean(
                    {
                      mean: number(displayRating(mean, data.question.scale), 2),
                      maximum: number(PUBLIC_RATING_SCALE.max),
                    },
                    options,
                  )}
                </strong>
              ) : null,
              countLabel,
            ]}
          />
        </p>
        {item.remaining !== undefined && (
          <p className="text-sm text-muted-foreground">
            {m.subject_ratings_remaining({ count: number(item.remaining) }, options)}
          </p>
        )}
      </div>
    );
  };

  const globalFigure = data.figures.find((item) => item.population === GLOBAL);
  const threshold = ['episode', 'character'].includes(data.question.grain) ? 10 : 5;
  const published = hasPublicMean(data.figure);
  const realms = data.realms
    .map((realm) => ({ realm, figure: data.figures.find((item) => item.population === realm.id) }))
    .sort((left, right) => (right.figure?.count ?? 0) - (left.figure?.count ?? 0));

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
      <div data-slot="rating-figures" className={realms.length ? 'grid gap-6 md:grid-cols-2' : 'space-y-4'}>
        <div className="space-y-3">
          <PublicRatingFigure figure={data.figure} locale={locale} remaining={threshold - data.figure.count} />
          {data.figure.count === 0 && data.figure.state !== 'updating' && (
            <p className="text-sm text-muted-foreground">{m.subject_ratings_empty({}, options)}</p>
          )}
          {published && globalFigure?.remaining === undefined && globalFigure?.histogram && (
            <details>
              <summary className="cursor-pointer text-sm">{m.subject_ratings_distribution({}, options)}</summary>
              <ol className="mt-2 grid max-w-sm grid-cols-3 gap-x-4 gap-y-1 text-xs tabular-nums" data-slot="histogram">
                {globalFigure.histogram.map((count, index) => (
                  <li key={index}>
                    {number(displayRating(data.question.scale.min + index, data.question.scale), 2)}: {number(count)}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <p className="text-xs text-muted-foreground">{m.rating_public_delay({}, options)}</p>
          <p className="text-xs text-muted-foreground">{m.rating_public_ordering({}, options)}</p>
        </div>
        {realms.length > 0 && (
          <ul className="space-y-4">
            {realms.map(({ realm, figure: item }) => (
              <li key={realm.id}>{figure(item, realm.name)}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-3">
        {!control && data.own !== null && (
          <p data-slot="own-rating" className="text-sm text-muted-foreground">
            {m.subject_ratings_yours({ score: number(displayRating(data.own, data.question.scale), 2) }, options)}
          </p>
        )}
        {data.statistics.map((item) => (
          <p key={item.source} data-slot="imported-score">
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
      <a data-slot="see-reviews" className={linkClass} href={reviewsHref}>
        {m.subject_ratings_reviews({}, options)}
      </a>
    </section>
  );
}
