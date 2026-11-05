import type { NumericProfileMetadata } from './values.ts';

/** Fixed-width digit strings order exactly across the kernel's decimal range. */
function comparableDecimal(text: string): string {
  const [whole, fraction = ''] = text.split('.');
  return whole!.padStart(12, '0') + fraction.padEnd(6, '0');
}

/** Consume compiler-validated numeric metadata without interpreting unit names or labels. */
export function acceptsProfileDecimal(metadata: NumericProfileMetadata, value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 19) return false;
  const match = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,6}))?$/.exec(value);
  // `$` can match before a final newline; require the entire original input.
  if (match === null || match[0] !== value) return false;
  if ((match[2]?.length ?? 0) > (metadata.precision ?? 6)) return false;

  const digits = comparableDecimal(value);
  return (
    (metadata.minimum === undefined || digits >= comparableDecimal(metadata.minimum)) &&
    (metadata.maximum === undefined || digits <= comparableDecimal(metadata.maximum))
  );
}

export const progressDecimalPattern = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
export type ProgressDecimalRules = Readonly<{
  min?: string | undefined;
  max?: string | undefined;
  step?: string | undefined;
}>;
export type ProgressInputIssue = 'required' | 'syntax' | 'min' | 'max' | 'precision' | 'locator';

/** A step supplied by the native profile describes precision, not a multiple of a unit. */
export function progressDecimalPlaces(step: string): number {
  return step.split('.')[1]?.length ?? 0;
}

/** Exact text in, exact validation out. Presentation adapters may handle surrounding whitespace explicitly. */
export function exactProgressDecimalIssue(
  value: string,
  rules: ProgressDecimalRules = {},
  required = true,
): ProgressInputIssue | null {
  if (value === '') return required ? 'required' : null;
  const match = progressDecimalPattern.exec(value);
  if (match === null || match[0] !== value) return 'syntax';
  if (rules.step && rules.step !== 'any' && (value.split('.')[1]?.length ?? 0) > progressDecimalPlaces(rules.step))
    return 'precision';
  const digits = comparableDecimal(value);
  if (rules.min !== undefined && digits < comparableDecimal(rules.min)) return 'min';
  if (rules.max !== undefined && digits > comparableDecimal(rules.max)) return 'max';
  return null;
}

/** Opaque locator length is measured in UTF-16 code units, matching the native writer. */
export function progressLocatorIssue(value: string): ProgressInputIssue | null {
  return value.length === 0 || value.length > 256 ? 'locator' : null;
}
