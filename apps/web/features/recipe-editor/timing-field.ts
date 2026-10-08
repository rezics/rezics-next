import { type Measure, minutesOf } from './model.ts';
import { amountText, wholeNumber } from './quantity.ts';

export type TimingLeave =
  | { kind: 'unchanged' }
  | { kind: 'invalid' }
  | { kind: 'write'; minutes: number | null };

/**
 * What the minutes field shows. A timing it can store is the number of minutes. Anything else
 * (seconds, a fraction of a minute, an IRI unit) is the stored amount and unit, never a blank box.
 */
export function timingShown(measure: Measure | undefined): string {
  const minutes = minutesOf(measure);
  if (minutes === null) return '';
  if (minutes !== 'other') return String(minutes);
  return `${amountText(measure?.value)} ${measure?.unitText ?? ''}`.trim();
}

/**
 * Leaving the field. The text it was already showing, including a value it cannot store as whole
 * minutes, is not a change and not a clear. Empty after a change clears. A whole number sets minutes.
 */
export function timingLeave(measure: Measure | undefined, typed: string): TimingLeave {
  const text = typed.trim();
  if (text === timingShown(measure)) return { kind: 'unchanged' };
  if (!text) return { kind: 'write', minutes: null };
  const minutes = wholeNumber(text);
  if (!minutes) return { kind: 'invalid' };
  return { kind: 'write', minutes: minutes.numerator };
}
