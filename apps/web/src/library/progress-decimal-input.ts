/** The existing BFF/native fixed-decimal grammar; editors trim only numeric operands. */
export const progressDecimalPattern = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;

export type ProgressDecimalRules = {
  min?: string | undefined;
  max?: string | undefined;
  step?: string | undefined;
};
export type ProgressInputIssue = 'required' | 'syntax' | 'min' | 'max' | 'precision' | 'locator';

function comparable(text: string): string {
  const [whole = '', fraction = ''] = text.split('.');
  return whole.padStart(12, '0') + fraction.padEnd(6, '0');
}

/** Native step is a descriptor precision hint, not a grid offset from minimum. */
export function progressDecimalPlaces(step: string): number {
  return step.split('.')[1]?.length ?? 0;
}

export function progressDecimalIssue(
  raw: string,
  rules: ProgressDecimalRules = {},
  required = true,
): ProgressInputIssue | null {
  const value = raw.trim();
  if (!value) return required ? 'required' : null;
  if (!progressDecimalPattern.test(value)) return 'syntax';
  const { min, max, step } = rules;
  if (step && step !== 'any' && (value.split('.')[1]?.length ?? 0) > progressDecimalPlaces(step)) return 'precision';
  const digits = comparable(value);
  if (min !== undefined && digits < comparable(min)) return 'min';
  if (max !== undefined && digits > comparable(max)) return 'max';
  return null;
}

/** Locators are opaque, including whitespace; native validation bounds UTF-16 length only. */
export function progressLocatorIssue(value: string): ProgressInputIssue | null {
  return value.length === 0 || value.length > 256 ? 'locator' : null;
}
