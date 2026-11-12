import { thumbHashToDataURL } from 'thumbhash';

// The pure rules behind `Cover`: frame ratios, placeholder colours, image fitting and the sizes it draws.

export type CoverSummary = {
  media: string;
  width: number;
  height: number;
  placeholder: { thumbhash: string; color: string };
  variants: { format: 'avif' | 'webp'; width: number }[];
  focalPoint: { x: number; y: number } | null;
  credit: { rightsHolder: string; via?: { name: string; url: string }; license?: string } | null;
  withheld?: 'suitability';
};
export type CoverSubject = { id: string; title: string; types: readonly string[]; byline?: string };
/** A compiled cover ratio; runtime values are validated against the definitions compiler's 1–64 bounds. */
export type CoverRatio = `${number}:${number}`;
export type CoverSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'fill';
export type CoverFormat = 'avif' | 'webp';
export type CoverFit = 'cover' | 'contain';
export type CoverVariant = CoverSummary['variants'][number];

export type ResolvedCoverVariant = CoverVariant & { src: string };

/** Published variants in a stable order, with duplicates and unusable widths removed. */
export function usableCoverVariants(variants: readonly CoverVariant[] | null | undefined): CoverVariant[] {
  const unique = new Map<string, CoverVariant>();
  for (const variant of variants ?? []) {
    if (
      (variant.format !== 'avif' && variant.format !== 'webp') ||
      !Number.isFinite(variant.width) ||
      !Number.isInteger(variant.width) ||
      variant.width <= 0
    )
      continue;
    unique.set(`${variant.format}:${variant.width}`, { format: variant.format, width: variant.width });
  }
  return [...unique.values()].toSorted((a, b) =>
    a.format === b.format ? a.width - b.width : a.format === 'avif' ? -1 : 1,
  );
}

/** Resolve each distinct published variant once for one render. */
export function resolveCoverVariants(
  cover: Pick<CoverSummary, 'media' | 'variants'>,
  src: (media: string, format: CoverFormat, width: number) => string,
): ResolvedCoverVariant[] {
  return usableCoverVariants(cover.variants).map((variant) => ({
    ...variant,
    src: src(cover.media, variant.format, variant.width),
  }));
}

/** One format's resolved, published sources as a `srcset`. */
export function resolvedCoverSrcSet(variants: readonly ResolvedCoverVariant[], format: CoverFormat): string {
  return variants
    .filter((variant) => variant.format === format && variant.src.trim() !== '')
    .map((variant) => `${variant.src} ${variant.width}w`)
    .join(', ');
}

/** The fallback variant for one display size, or null when no usable source was published. */
export function resolvedCoverFallback(
  variants: readonly ResolvedCoverVariant[],
  format: CoverFormat,
  size: CoverSize,
): ResolvedCoverVariant | null {
  const available = variants.filter(
    (variant) =>
      variant.format === format &&
      Number.isFinite(variant.width) &&
      Number.isInteger(variant.width) &&
      variant.width > 0 &&
      variant.src.trim() !== '',
  );
  const wanted = (size === 'fill' ? fillReferenceWidth : coverWidths[size]) * 3;
  return available.find((variant) => variant.width >= wanted) ?? available.at(-1) ?? null;
}

/** Stable identity for the published cover and the actual variant URLs the current resolver supplies. */
export function coverIncarnation(
  subject: Pick<CoverSubject, 'id' | 'types'>,
  cover: CoverSummary | null,
  resolved: readonly ResolvedCoverVariant[],
): string {
  const topCrop = keepsTop(subject.types);
  const variants = usableCoverVariants(cover?.variants).map((variant) => [variant.format, variant.width]);
  const addresses = resolved.map((variant) => [variant.format, variant.width, variant.src]);
  const focalPoint = cover?.focalPoint;
  const credit = cover?.credit;
  return JSON.stringify({
    subject: [subject.id, topCrop],
    cover: cover
      ? {
          media: cover.media,
          width: cover.width,
          height: cover.height,
          placeholder: [cover.placeholder?.color ?? null, cover.placeholder?.thumbhash ?? null],
          variants,
          addresses,
          focalPoint:
            focalPoint && Number.isFinite(focalPoint.x) && Number.isFinite(focalPoint.y)
              ? [focalPoint.x, focalPoint.y]
              : null,
          withheld: cover.withheld ?? null,
          credit: credit
            ? [credit.rightsHolder, credit.via?.name ?? null, credit.via?.url ?? null, credit.license ?? null]
            : null,
        }
      : null,
  });
}

/** Width in CSS pixels of each named size; `fill` is sized by its parent. */
export const coverWidths = { xs: 48, sm: 96, md: 160, lg: 240, xl: 320 } as const;
/** The width an intrinsic `width` and `height` are computed from when a frame fills its parent. */
export const fillReferenceWidth = 320;

/** The default identity frame for every kind, independent of the source artwork's dimensions. */
export const defaultCoverRatio: CoverRatio = '5:7';

const validCoverRatio = /^(?:[1-9]|[1-5][0-9]|6[0-4]):(?:[1-9]|[1-5][0-9]|6[0-4])$(?![\s\S])/u;

/** Returns a ratio the definitions compiler accepts, preserving its exact `W:H` form. */
export function parseCoverRatio(value: string): CoverRatio | undefined {
  return validCoverRatio.test(value) ? (value as CoverRatio) : undefined;
}

/** Every semantic Type has the same default frame, never inferred from its image. */
export function coverRatio(_types: readonly string[]): CoverRatio {
  return defaultCoverRatio;
}

/** A stable default for rows and grids, including empty and mixed-kind compositions. */
export function sharedRatio(_subjects: readonly CoverSubject[]): CoverRatio {
  return defaultCoverRatio;
}

export function ratioValue(ratio: CoverRatio): number {
  const [width, height] = ratio.split(':').map(Number);
  return width! / height!;
}

/** Bound both axes through the effective ratio, so a block limit never crops the aspect frame. */
export function coverFrameStyle(size: CoverSize, ratio: CoverRatio, maxBlockSize?: number) {
  const width = size === 'fill' ? '100%' : `${coverWidths[size]}px`;
  return maxBlockSize === undefined
    ? { width }
    : {
        width: `min(${width}, ${maxBlockSize * ratioValue(ratio)}px)`,
        maxBlockSize,
      };
}

/** Portraits of characters and people keep the top of the image when it is cropped. */
export function keepsTop(types: readonly string[]): boolean {
  return types.some((type) => ['schema:Person', 'wd:Q5', 'wd:Q95074'].includes(type));
}

/**
 * An image within 15% of the frame ratio fills the frame; a wider or taller one is shown whole on its placeholder
 * colour, so landscape package art in a portrait slot is never cut to a sliver.
 */
export function coverFit(image: { width: number; height: number }, ratio: CoverRatio): CoverFit {
  const frame = ratioValue(ratio);
  return Math.abs(image.width / image.height / frame - 1) <= 0.15 ? 'cover' : 'contain';
}

/** The CSS `object-position` of a cover: the top for portraits, else the stored focal point or the centre. */
export function objectPosition(types: readonly string[], focalPoint: CoverSummary['focalPoint']): string {
  if (keepsTop(types)) return 'top';
  const percent = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 10000) / 100}%`;
  return focalPoint ? `${percent(focalPoint.x)} ${percent(focalPoint.y)}` : '50% 50%';
}

/** Light text on every background, at least 5.5:1, so the placeholder reads the same in both themes. */
const foreground = '#fbf8f3';

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return value;
}

function hex(value: number): string {
  return Math.round(value * 255)
    .toString(16)
    .padStart(2, '0');
}

function placeholderColor(id: string): string {
  const hue = (hash(id) % 360) / 60;
  const saturation = 0.48;
  const lightness = 0.24;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs((hue % 2) - 1));
  const offset = lightness - chroma / 2;
  const [red, green, blue] =
    hue < 1
      ? [chroma, secondary, 0]
      : hue < 2
        ? [secondary, chroma, 0]
        : hue < 3
          ? [0, chroma, secondary]
          : hue < 4
            ? [0, secondary, chroma]
            : hue < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  return `#${hex(red! + offset)}${hex(green! + offset)}${hex(blue! + offset)}`;
}

/** The placeholder colours of a subject: both are fixed by its id alone and stay the same on every surface. */
export function placeholderColors(subject: Pick<CoverSubject, 'id' | 'types'>): {
  background: string;
  foreground: string;
} {
  return { background: placeholderColor(subject.id), foreground };
}

/** The `sizes` attribute of a named size, so the browser picks the smallest sufficient variant. */
export function coverSizes(size: CoverSize): string {
  return size === 'fill' ? '100vw' : `${coverWidths[size]}px`;
}

/** Intrinsic width and height of the frame, which reserve its box before any byte arrives. */
export function intrinsicSize(size: CoverSize, ratio: CoverRatio): { width: number; height: number } {
  const width = size === 'fill' ? fillReferenceWidth : coverWidths[size];
  return { width, height: Math.round(width / ratioValue(ratio)) };
}

/** Variants of one format as a `srcset`, ascending by width. */
export function coverSrcSet(
  media: string,
  variants: CoverSummary['variants'],
  format: CoverFormat,
  src: (media: string, format: CoverFormat, width: number) => string,
): string {
  return usableCoverVariants(variants)
    .filter((variant) => variant.format === format)
    .map((variant) => ({ ...variant, src: src(media, format, variant.width) }))
    .filter((variant) => variant.src.trim() !== '')
    .map((variant) => `${variant.src} ${variant.width}w`)
    .join(', ');
}

/** The fallback `src`: the smallest variant that serves a 3x display of the size, else the largest. */
export function coverFallback(
  media: string,
  variants: CoverSummary['variants'],
  format: CoverFormat,
  size: CoverSize,
  src: (media: string, format: CoverFormat, width: number) => string,
): string {
  const resolved = usableCoverVariants(variants)
    .filter((variant) => variant.format === format)
    .map((variant) => ({ ...variant, src: src(media, format, variant.width) }));
  return resolvedCoverFallback(resolved, format, size)?.src ?? '';
}

const decoded = new Map<string, string | null>();

/** A ThumbHash as a PNG data URL, or null when it does not decode. Decoded hashes are kept for reuse. */
export function thumbhashImage(hash: string): string | null {
  const known = decoded.get(hash);
  if (known !== undefined) return known;
  let url: string | null = null;
  try {
    url = thumbHashToDataURL(Uint8Array.from(atob(hash), (character) => character.charCodeAt(0)));
  } catch {
    url = null;
  }
  if (decoded.size >= 512) decoded.delete(decoded.keys().next().value!);
  decoded.set(hash, url);
  return url;
}
