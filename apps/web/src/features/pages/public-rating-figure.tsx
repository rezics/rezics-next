import { MetaLine } from '@rezics/ui/meta-line';
import { m } from '../../paraglide/messages.js';
import { hasPublicMean, PUBLIC_RATING_SCALE, type PublicFigure } from './subject-ratings';

/** A published opinion measurement has no shadcn equivalent. Shared by subject pages and Search rows. */
export function PublicRatingFigure({
  figure,
  locale,
  remaining,
}: {
  figure: PublicFigure;
  locale: string;
  remaining?: number;
}) {
  const options = { locale: locale as never };
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
  const published = hasPublicMean(figure);
  if (figure.count === 0 && figure.state !== 'updating') return null;
  return (
    <div data-slot="public-rating-figure" data-state={figure.state} className="space-y-1 text-sm">
      {figure.count > 0 && (
        <p>
          <MetaLine
            items={[
              published ? (
                <strong className="tabular-nums">
                  {m.rating_public_mean(
                    {
                      mean: number(figure.mean),
                      maximum: number(PUBLIC_RATING_SCALE.max),
                    },
                    options,
                  )}
                </strong>
              ) : null,
              m.rating_public_count({ count: number(figure.count) }, options),
            ]}
          />
        </p>
      )}
      {figure.state === 'updating' ? (
        <p role="status" className="text-muted-foreground">
          {m.rating_public_updating({}, options)}
        </p>
      ) : !published && figure.count > 0 ? (
        <p className="text-muted-foreground">
          {remaining !== undefined && remaining > 0
            ? m.subject_ratings_remaining({ count: number(remaining) }, options)
            : m.rating_public_insufficient({}, options)}
        </p>
      ) : null}
    </div>
  );
}
