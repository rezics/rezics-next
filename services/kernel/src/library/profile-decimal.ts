import type { LibraryProgressUnit } from '@rezics/definitions';

export type NumericProfileMetadata = Pick<LibraryProgressUnit, 'minimum' | 'maximum' | 'precision'>;

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
