/** Finite correspondence for the admitted Episode occurrence fields. This is
 * primitive validation, not a provider conversion or native write. */
export type EpisodeOccurrenceField = 'position' | 'disc' | 'kindCode';
const episodeFieldPaths = new Map<string, EpisodeOccurrenceField>([
  ['/data/sort', 'position'],
  ['/data/disc', 'disc'],
  ['/data/type', 'kindCode'],
]);
export const episodeOccurrenceField = (pointer: string): EpisodeOccurrenceField | undefined =>
  episodeFieldPaths.get(pointer);

/** Preserve the JSON number's exact decimal meaning; never floor a position.
 * Bounds are the existing native rational bounds, applied after reduction. */
export function episodeRational(
  raw: unknown,
  integer = false,
): { numerator: number; denominator: number } | null {
  if (typeof raw !== 'string' && (typeof raw !== 'number' || !Number.isFinite(raw))) return null;
  const text = String(raw);
  if (text.length > 64) return null;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,2}))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? '',
    scale = fraction.length - Number(match[3] ?? 0);
  if (Math.abs(scale) > 64) return null;
  let numerator = BigInt(match[1]! + fraction),
    denominator = 1n;
  if (scale > 0) denominator = 10n ** BigInt(scale);
  else numerator *= 10n ** BigInt(-scale);
  let a = numerator,
    b = denominator;
  while (b) [a, b] = [b, a % b];
  numerator /= a;
  denominator /= a;
  if (
    numerator > 1_000_000_000_000n ||
    denominator > 1_000_000_000_000n ||
    (integer && denominator !== 1n)
  )
    return null;
  return { numerator: Number(numerator), denominator: Number(denominator) };
}

export function episodeKindCode(raw: unknown): string | null {
  const rational = episodeRational(raw, true);
  return rational ? String(rational.numerator) : null;
}
