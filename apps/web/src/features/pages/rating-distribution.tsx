import { m } from '../../paraglide/messages.js';
import { displayRating, GLOBAL, hasPublicMean, type Figure, type Ratings } from './subject-ratings';

/** Only a supplied, eligible Global distribution accompanies the published headline. */
export function RatingDistribution({
  figure,
  headline,
  question,
  locale,
}: {
  figure: Figure | undefined;
  headline: Ratings['figure'];
  question: Ratings['question'];
  locale: string;
}) {
  const { scale } = question;
  const histogram = figure?.histogram;
  if (
    !hasPublicMean(headline) ||
    headline.questionId !== question.id ||
    figure?.population !== GLOBAL ||
    figure.count !== headline.count ||
    figure.remaining !== undefined ||
    figure.freshness?.updating === true ||
    figure.mean === undefined ||
    !Number.isFinite(figure.mean) ||
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
      <summary className="cursor-pointer text-sm font-medium">{m.subject_ratings_distribution({}, options)}</summary>
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
