import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { ProgressMode } from './progress-reads';

export type ProgressLabelInput = {
  mode: ProgressMode;
  unit: string;
  amount: string | null;
  total: string | null;
  completedUnitCount: number;
  locator: string | null;
  position?: string | null;
  unitLabel?: string;
  dimension?: string;
};

export type ProgressView = { text: string; percent: number | null };

function amountOf(value: string | number | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/** The amount, in the reader's language, and its share of the total when the session knows one. */
export function progressView(progress: ProgressLabelInput | null, locale: string): ProgressView | null {
  if (!progress) return null;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
  const options = { locale: locale as Locale };
  const inProgress = { text: m.home_continue_in_progress({}, options), percent: null };

  if (progress.mode === 'cursor_position' && progress.position == null) {
    const locator = progress.locator?.trim();
    if (!locator) return inProgress;
    const partAndChapter = /^(?:part|Part)\s+(\d+)\s*[,;:]?\s*(?:chapter|Chapter)\s+(\d+)$/i.exec(locator);
    if (partAndChapter) {
      return {
        text: m.library_progress_locator_part_chapter(
          { part: number.format(Number(partAndChapter[1])), chapter: number.format(Number(partAndChapter[2])) },
          options,
        ),
        percent: null,
      };
    }
    const chapter = /^(?:chapter|Chapter)\s+(\d+)$/i.exec(locator);
    if (chapter) {
      return {
        text: m.library_progress_locator_chapter({ chapter: number.format(Number(chapter[1])) }, options),
        percent: null,
      };
    }
    return { text: locator, percent: null };
  }

  const amount =
    progress.mode === 'completed_units'
      ? amountOf(progress.completedUnitCount)
      : amountOf(progress.mode === 'cursor_position' ? (progress.position ?? null) : progress.amount);
  if (amount === null) return inProgress;
  const total = amountOf(progress.total);
  const percent = progress.dimension === 'percent';
  const withTotal = total !== null && !percent ? `${number.format(amount)} / ${number.format(total)}` : null;
  const valueText = percent
    ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 6 }).format(amount / 100)
    : `${withTotal ?? number.format(amount)}${progress.unitLabel ? `\u00a0${progress.unitLabel.replaceAll(' ', '\u00a0')}` : ''}`;
  const share = percent ? amount : total !== null && total > 0 ? (amount / total) * 100 : null;
  return {
    text: valueText,
    percent: share === null ? null : Math.min(100, Math.max(0, share)),
  };
}
