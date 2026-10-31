import { progressView, type ProgressLabelInput } from './progress-label';

/** A scalar record replaces amount. Its captured denominator is a separate, immutable fact. */
export function scalarRecordingValue(
  session: ProgressLabelInput,
  amount: string | null,
  locale: string,
): string | null {
  if (
    session.mode !== 'scalar_amount' ||
    amount === null ||
    !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(amount.trim())
  )
    return null;
  return progressView({ ...session, amount: amount.trim(), total: null }, locale)?.text ?? null;
}
