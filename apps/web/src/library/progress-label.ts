import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { ProgressMode, ProgressUnitRead, ProgressUnitWrite } from './progress-reads';

export type ProgressLabelInput = {
  mode: ProgressMode;
  unit: ProgressUnitRead;
  amount: string | null;
  total: string | null;
  completedUnitCount: number;
  locator: string | null;
};

export type ProgressView = { text: string; percent: number | null };

const writableProgressUnits = new Set<string>(['page', 'chapter', 'episode', 'volume', 'minute', 'percent']);

function isWritableProgressUnit(unit: ProgressUnitRead): unit is ProgressUnitWrite {
  return writableProgressUnits.has(unit);
}

function amountOf(value: string | number | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/** The amount, in the reader's language, and its share of the total when the session knows one. */
export function progressView(progress: ProgressLabelInput | null, locale: string): ProgressView | null {
  if (!progress) return null;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const options = { locale: locale as Locale };
  const inProgress = { text: m.home_continue_in_progress({}, options), percent: null };

  if (!isWritableProgressUnit(progress.unit)) {
    return { text: m.library_other(), percent: null };
  }

  if (progress.mode === 'cursor_position') {
    const locator = progress.locator?.trim();
    return locator ? { text: locator, percent: null } : inProgress;
  }

  const amount =
    progress.mode === 'completed_units' ? amountOf(progress.completedUnitCount) : amountOf(progress.amount);
  if (amount === null) return inProgress;
  const shown = { amount: number.format(amount) };
  const total = progress.mode === 'scalar_amount' ? amountOf(progress.total) : null;
  const withTotal =
    total !== null && total > 0 && progress.unit !== 'percent' ? { ...shown, total: number.format(total) } : null;
  const text =
    progress.unit === 'percent'
      ? m.home_continue_percent(shown, options)
      : withTotal
        ? m[`home_continue_${progress.unit}_of`](withTotal, options)
        : m[`home_continue_${progress.unit}`](shown, options);
  const share = progress.unit === 'percent' ? amount : total !== null && total > 0 ? (amount / total) * 100 : null;
  return {
    text,
    percent: share === null ? null : Math.min(100, Math.max(0, share)),
  };
}
