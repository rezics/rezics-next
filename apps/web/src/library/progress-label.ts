import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { LibraryCountForms } from '@rezics/definitions';
import type { ProgressFailure, ProgressMode } from './progress-reads';

export function progressFailureMessage(reason: ProgressFailure['reason']): string {
  if (reason === 'unsupported_library_profile') return m.library_progress_unsupported();
  if (reason === 'conflict') return m.library_progress_conflict();
  if (reason === 'forbidden' || reason === 'closed') return m.library_progress_refused();
  if (reason === 'unavailable') return m.library_progress_unavailable();
  return m.library_progress_invalid();
}

export type ProgressLabelInput = {
  mode: ProgressMode;
  unit: string;
  amount: string | null;
  total: string | null;
  completedUnitCount: number;
  locator: string | null;
  position?: string | null;
  unitLabel?: string;
  unitLabelLanguage?: string;
  unitCountForms?: LibraryCountForms;
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
    return progress.locator ? { text: progress.locator, percent: null } : inProgress;
  }

  const amount =
    progress.mode === 'completed_units'
      ? amountOf(progress.completedUnitCount)
      : amountOf(progress.mode === 'cursor_position' ? (progress.position ?? null) : progress.amount);
  if (amount === null) return inProgress;
  // Keep accepted decimal text exact; Number is used only for the visual share and plural category.
  const exact = (value: string | number): string => {
    const text = String(value);
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) return number.format(Number(value));
    const [integer = '0', fraction] = text.split('.');
    const whole = number.format(BigInt(integer));
    if (!fraction) return whole;
    const separator = number.formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
    const digits = new Intl.NumberFormat(locale, { useGrouping: false });
    return `${whole}${separator}${[...fraction].map((digit) => digits.format(Number(digit))).join('')}`;
  };
  const amountText = exact(
    progress.mode === 'completed_units'
      ? progress.completedUnitCount
      : progress.mode === 'cursor_position'
        ? progress.position!
        : progress.amount!,
  );
  const total = amountOf(progress.total);
  const totalText = total === null ? '' : exact(progress.total!);
  const percent = progress.dimension === 'percent';
  const withTotal = total !== null && !percent ? `${amountText} / ${totalText}` : null;
  const unitCount = withTotal === null ? amount : total!;
  const countCategory =
    progress.unitLabelLanguage && progress.unitCountForms
      ? new Intl.PluralRules(progress.unitLabelLanguage).select(unitCount)
      : undefined;
  const unitLabel = progress.unitLabel
    ? ((countCategory ? progress.unitCountForms?.[countCategory] : undefined) ?? progress.unitLabel)
    : undefined;
  const valueText = percent
    ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 6 }).format(amount / 100)
    : unitLabel
      ? withTotal === null
        ? m.home_continue_amount({ amount: amountText, unit: unitLabel }, options)
        : m.home_continue_amount_of_total({ amount: amountText, total: totalText, unit: unitLabel }, options)
      : (withTotal ?? amountText);
  const share = percent ? amount : total !== null && total > 0 ? (amount / total) * 100 : null;
  return {
    text: valueText,
    percent: share === null ? null : Math.min(100, Math.max(0, share)),
  };
}
