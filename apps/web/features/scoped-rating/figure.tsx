import { cn } from '@rezics/ui/utils';
import type { UiLocale } from '../../i18n/define.ts';
import { StarMeter } from '../catalogue/rating.tsx';
import { formatMean, formatNumber, formatShare, translate } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { bars, scoreView, type Figures } from './score.ts';

interface FigureProps {
  locale: UiLocale;
  messages: ScopedRatingMessages;
  className?: string;
}

/** The bars of a histogram from the top score down. Nothing is drawn where nobody has rated. */
export function Histogram({ figures, locale, messages, className }: FigureProps & { figures: Figures }) {
  const t = translate(messages, locale);
  const rows = bars(figures);
  if (!rows) return null;
  return <ol aria-label={t.histogram} className={cn('grid gap-1.5', className)}>
    {rows.map(({ value, count }) => <li key={value}
      className="grid grid-cols-[1.75rem_minmax(0,1fr)_6.5rem] items-center gap-3 text-sm">
      <span className="text-end font-medium tabular-nums">{formatNumber(value, locale)}</span>
      <span aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-rating" style={{ width: `${(count / figures.count) * 100}%` }} /></span>
      <span className="text-muted-foreground tabular-nums">
        {t.barCount({ count: formatNumber(count, locale), share: formatShare(count, figures.count, locale) })}</span>
    </li>)}
  </ol>;
}

/**
 * One target's figures for one question, only as far as they are true. A mean shows as "8/10 · 7 ratings" with its
 * unit; below the question's display threshold the count shows with how many more ratings reveal the average; with
 * no ratings it says so. Never a zero, a placeholder star or a histogram of nothing.
 */
export function ScoreFigure({ figures, histogram = false, locale, messages, className }: FigureProps & {
  figures: Figures; histogram?: boolean;
}) {
  const t = translate(messages, locale);
  const view = scoreView(figures);
  if (view.kind === 'none') {
    return <p data-score="none" className={cn('text-muted-foreground text-sm', className)}>{t.noRatings}</p>;
  }
  const chart = histogram ? <Histogram figures={figures} locale={locale} messages={messages} className="mt-3" /> : null;
  if (view.kind === 'withheld') {
    return <div data-score="withheld" className={cn('grid gap-0.5', className)}>
      <p className="font-medium text-sm tabular-nums">{t.ratingCount(view.count)}</p>
      <p className="text-muted-foreground text-sm">
        {view.remaining === null ? t.moreToRevealUnknown : t.moreToReveal(view.remaining)}</p>
      {chart}
    </div>;
  }
  const mean = formatMean(view.mean, locale);
  const max = formatNumber(view.max, locale);
  return <div data-score="shown" className={className}>
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <StarMeter mean={view.mean} max={view.max} className="text-lg" />
      <span className="font-semibold text-base tabular-nums">{t.score({ mean, max })}
        <span className="sr-only"> — {t.scoreSpoken({ mean, max })}</span></span>
      <span aria-hidden="true" className="text-muted-foreground">·</span>
      <span className="text-muted-foreground tabular-nums">{t.ratingCount(view.count)}</span>
    </p>
    {chart}
  </div>;
}
