import { m } from '../../paraglide/messages.js';
import { displayRating, GLOBAL, QUESTION, hasPublicMean, type Figure, type Ratings } from './subject-ratings';

/** A healthy eligible Global distribution survives an unavailable headline without lowering its privacy threshold. */
export function RatingDistribution({
  figure,
  headline,
  question,
  locale,
}: {
  figure: Figure | undefined;
  headline?: Ratings['figure'] | undefined;
  question: Ratings['question'];
  locale: string;
}) {
  const { scale } = question;
  const histogram = figure?.histogram;
  if (
    question.id !== QUESTION ||
    !Number.isSafeInteger(figure?.count) ||
    (headline !== undefined &&
      (!hasPublicMean(headline) || headline.questionId !== question.id || figure?.count !== headline.count)) ||
    (figure?.count ?? 0) < (['episode', 'character'].includes(question.grain) ? 10 : 5) ||
    figure?.population !== GLOBAL ||
    figure.remaining !== undefined ||
    figure.freshness?.updating === true ||
    figure.mean === undefined ||
    !Number.isFinite(figure.mean) ||
    figure.mean < scale.min ||
    figure.mean > scale.max ||
    !histogram ||
    scale.max <= scale.min ||
    scale.displayStep <= 0 ||
    histogram.length !== (scale.max - scale.min) / scale.displayStep + 1 ||
    histogram.some((count) => !Number.isSafeInteger(count) || count < 0)
  )
    return null;

  const options = { locale: locale as never };
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  // An honestly supplied all-zero series stays empty, with no division by zero.
  const maximum = histogram.reduce((max, count) => Math.max(max, count), 0) || 1;
  return (
    <details data-slot="rating-distribution">
      <summary className="list-item list-inside min-h-11 min-w-11 max-w-full cursor-pointer rounded-sm px-2 py-3 text-start text-sm font-medium whitespace-normal wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {m.subject_ratings_distribution({}, options)}
      </summary>
      <ol
        aria-label={m.subject_ratings_distribution({}, options)}
        data-slot="histogram"
        className="mt-3 max-w-xl space-y-1.5 text-xs tabular-nums"
      >
        {histogram.map((count, index) => {
          const label = number(displayRating(scale.min + index * scale.displayStep, scale));
          return (
            <li key={index} className="grid grid-cols-[3.5rem_minmax(0,1fr)_max-content] items-center gap-2">
              <span>{label}</span>
              <span aria-hidden="true" className="h-2 overflow-hidden rounded-sm bg-muted">
                <span className="block h-full rounded-sm bg-primary" style={{ width: `${(count / maximum) * 100}%` }} />
              </span>
              <span className="text-end">
                <span className="sr-only">{m.subject_ratings_bucket_count({}, options)} </span>
                {number(count)}
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
