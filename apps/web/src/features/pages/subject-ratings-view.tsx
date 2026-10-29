import { createContext, useContext } from 'react';
import { m } from '../../paraglide/messages.js';
import { GLOBAL, type Figure, type Ratings } from './subject-ratings';

const sectionClass = 'min-w-0 space-y-4 in-data-[density=compact]:space-y-3';
const headingClass =
  'text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl';
const linkClass = 'text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80';

export const RatingsContext = createContext<Ratings | null | undefined>(undefined);
/** Story fixtures can show each display state without adding another request to the subject page. */
export const RatingsPreviewContext = createContext<Ratings | null | undefined>(undefined);

function RatingsFailure({
  id,
  subject,
  locale,
  unavailable = false,
}: {
  id: string;
  subject: string;
  locale: string;
  unavailable?: boolean;
}) {
  const options = { locale: locale as never };
  const reviewsHref = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject)}/reviews`;
  return (
    <section
      data-slot="rating-summary"
      data-state={unavailable ? 'unavailable' : 'failed'}
      aria-labelledby={`${id}-title`}
      className={sectionClass}
    >
      <h2 id={`${id}-title`} className={headingClass}>
        {m.subject_ratings({}, options)}
      </h2>
      <p role="status" className="text-sm text-muted-foreground">
        {unavailable ? m.subject_ratings_unavailable({}, options) : m.subject_section_failed({}, options)}
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
  const data = previewData === undefined ? routeData : previewData;

  if (data === null) return <RatingsFailure id={id} subject={subject} locale={locale} />;
  if (data === undefined) return <RatingsFailure id={id} subject={subject} locale={locale} unavailable />;

  return <RatingsView data={data} id={id} subject={subject} locale={locale} />;
}

export function RatingsView({
  data,
  id,
  subject,
  locale,
}: {
  data: Ratings | null;
  id: string;
  subject: string;
  locale: string;
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

  const figure = (item: Figure | undefined, label: string, global: boolean) => {
    if (!item || item.count === 0)
      return (
        <p>
          <span className="font-medium">{label}</span> · {m.subject_ratings_empty({}, options)}
        </p>
      );

    const count = number(item.count);
    const countLabel = global
      ? m.subject_ratings_count({ count, population: label }, options)
      : m.subject_ratings_realm_count({ count, population: label }, options);
    const histogram = item.histogram;
    const maximum = histogram?.reduce((largest, current) => Math.max(largest, current), 1) ?? 1;
    const mean = item.remaining === undefined ? item.mean : undefined;

    return (
      <div>
        <p>
          {mean !== undefined && <strong className="text-xl tabular-nums">{number(mean / 2, 1)} · </strong>}
          {countLabel}
        </p>
        {item.remaining !== undefined && (
          <p className="text-sm text-muted-foreground">
            {m.subject_ratings_remaining({ count: number(item.remaining) }, options)}
          </p>
        )}
        {global && mean !== undefined && histogram && (
          <div
            data-slot="histogram"
            role="img"
            aria-label={m.subject_ratings_distribution({}, options)}
            className="mt-3 flex h-12 max-w-xs items-end gap-0.5"
          >
            {histogram.map((value, index) => (
              <span
                key={index}
                title={`${number(index / 2, 1)}: ${number(value)}`}
                className="min-w-0 flex-1 rounded-t bg-primary"
                style={{ height: `${Math.max(2, (value / maximum) * 100)}%` }}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  const globalFigure = data.figures.find((item) => item.population === GLOBAL);
  const realms = data.realms
    .map((realm) => ({ realm, figure: data.figures.find((item) => item.population === realm.id) }))
    .sort((left, right) => (right.figure?.count ?? 0) - (left.figure?.count ?? 0));

  return (
    <section data-slot="rating-summary" aria-labelledby={`${id}-title`} className={sectionClass}>
      <h2 id={`${id}-title`} className={headingClass}>
        {title}
      </h2>
      <div data-slot="rating-figures" className={realms.length ? 'grid gap-6 md:grid-cols-2' : 'space-y-4'}>
        <div>{figure(globalFigure, 'REZICS', true)}</div>
        {realms.length > 0 && (
          <ul className="space-y-4">
            {realms.map(({ realm, figure: item }) => (
              <li key={realm.id}>{figure(item, realm.name, false)}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-3">
        {data.own !== null && (
          <p data-slot="own-rating" className="text-sm text-muted-foreground">
            {m.subject_ratings_yours({ score: number(data.own / 2, 1) }, options)}
          </p>
        )}
        {data.statistics.map((item) => (
          <p key={item.source} data-slot="imported-score">
            <span className="font-medium">{item.source === 'vndb' ? 'VNDB' : item.source}</span> ·{' '}
            <strong className="tabular-nums">
              {number(item.mean, 2)} ({number(item.scale.min)}–{number(item.scale.max)})
            </strong>{' '}
            · {m.subject_ratings_imported({ count: number(item.count), date: date(item.asOf) }, options)}
          </p>
        ))}
      </div>
      <a data-slot="see-reviews" className={linkClass} href={reviewsHref}>
        {m.subject_ratings_reviews({}, options)}
      </a>
    </section>
  );
}
