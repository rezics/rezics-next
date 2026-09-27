import { cn } from '@rezics/ui/utils';
import { StarIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { messages } from './messages.ts';
import { type CardRating, formatCompact, formatMean } from './work.ts';

/** The spoken form of a rating: mean, scale and count, or the reader's own value. */
export function ratingLabel(rating: CardRating, locale: UiLocale): string {
  const t = materializeData(messages[locale], { locale });
  const mean = formatMean(rating.mean, locale);
  const max = String(rating.max);
  return rating.own ? t.ownRating({ value: mean, max }) : t.averageRating({ mean, max, count: t.ratingCount(rating.count) });
}

/**
 * `★ 4.26 · 41.9K`: a card's rating as Goodreads shows it. A ten-point
 * Realm scale keeps its `/10`, so a mean is never read on the wrong scale;
 * the reader's own rating says so instead of a count.
 */
export function RatingInline({ rating, locale, className }: { rating: CardRating; locale: UiLocale; className?: string }) {
  const t = materializeData(messages[locale], { locale });
  return <p className={cn('flex min-w-0 items-center gap-1 text-sm', className)}>
    <span className="sr-only">{ratingLabel(rating, locale)}</span>
    <StarIcon aria-hidden="true" className="size-3.5 shrink-0 fill-current text-rating" />
    <span aria-hidden="true" className="font-semibold tabular-nums">{formatMean(rating.mean, locale)}
      {rating.max === 5 ? null : <span className="font-normal text-muted-foreground">/{rating.max}</span>}</span>
    <span aria-hidden="true" className="truncate text-muted-foreground">
      · {rating.own ? t.yourRating : formatCompact(rating.count, locale)}</span>
  </p>;
}

/**
 * A mean as five stars, the last one filled in proportion, for the Work page.
 * Decorative: the number beside it carries the value.
 */
export function StarMeter({ mean, max, className }: { mean: number; max: number; className?: string }) {
  const filled = Math.max(0, Math.min(5, (mean / max) * 5));
  return <span aria-hidden="true" className={cn('relative inline-flex shrink-0 gap-1', className)}>
    {[0, 1, 2, 3, 4].map(star => <StarIcon key={star} className="size-[1em] text-border" fill="currentColor" strokeWidth={0} />)}
    <span className="absolute inset-y-0 start-0 flex gap-1 overflow-hidden text-rating"
      style={{ width: `calc(${filled} * 1em + ${Math.floor(filled)} * 0.25rem)` }}>
      {[0, 1, 2, 3, 4].map(star => <StarIcon key={star} className="size-[1em] shrink-0" fill="currentColor" strokeWidth={0} />)}
    </span>
  </span>;
}
