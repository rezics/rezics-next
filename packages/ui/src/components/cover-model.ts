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

/** Width in CSS pixels of each named size; `fill` is sized by its parent. */
export const coverWidths = { xs: 48, sm: 96, md: 160, lg: 240, xl: 320 } as const;
/** The width an intrinsic `width` and `height` are computed from when a frame fills its parent. */
export const fillReferenceWidth = 320;

type Family = 'work' | 'game' | 'music' | 'recipe' | 'person' | 'other';

const familyRatios: Record<Family, CoverRatio> = {
  work: '5:7',
  game: '5:7',
  music: '1:1',
  recipe: '4:3',
  person: '3:4',
  other: '1:1',
};

const validCoverRatio = /^(?:[1-9]|[1-5][0-9]|6[0-4]):(?:[1-9]|[1-5][0-9]|6[0-4])$(?![\s\S])/u;

/** Returns a ratio the definitions compiler accepts, preserving its exact `W:H` form. */
export function parseCoverRatio(value: string): CoverRatio | undefined {
  return validCoverRatio.test(value) ? (value as CoverRatio) : undefined;
}

// The default table of the Cover README, by type CURIE. A definition release that carries a `coverRatio` annotation
// replaces it: the site resolves that and passes `ratio`, so this map is the fallback.
const familyOf: Record<string, Family> = {
  'schema:Book': 'work',
  'wd:Q47461344': 'work',
  'bf:Instance': 'work',
  'wd:Q3331189': 'work',
  'schema:BookSeries': 'work',
  'wd:Q277759': 'work',
  'schema:ComicSeries': 'work',
  'wd:Q21198342': 'work',
  'schema:PublicationVolume': 'work',
  'wd:Q1238720': 'work',
  'schema:TVSeries': 'work',
  'wd:Q5398426': 'work',
  'schema:TVSeason': 'work',
  'wd:Q3464665': 'work',
  'schema:Movie': 'work',
  'wd:Q11424': 'work',
  'wd:Q1983062': 'work',
  'wd:Q689445': 'game',
  'wd:Q7889': 'game',
  'wd:Q20631656': 'game',
  'wd:Q209163': 'game',
  'schema:VideoGame': 'game',
  'schema:MusicAlbum': 'music',
  'schema:Recipe': 'recipe',
  'schema:Place': 'recipe',
  'schema:Event': 'recipe',
  'schema:Person': 'person',
  'wd:Q5': 'person',
  'wd:Q95074': 'person',
  'schema:Organization': 'other',
  'wd:Q43229': 'other',
  'wd:Q219239': 'recipe',
  'wd:Q482994': 'music',
};

// Creative-work types with no more specific entry above: they still use the work ratio.
const creativeWorks = new Set([
  'schema:CreativeWork',
  'schema:CreativeWorkSeries',
  'schema:CreativeWorkSeason',
  'schema:Episode',
  'schema:MusicComposition',
  'wd:Q7725310',
]);

/** The type family of a subject: the nearest listed type with an entry, else creative work, else other. */
function coverFamily(types: readonly string[]): Family {
  for (const type of types) {
    const family = familyOf[type];
    if (family) return family;
  }
  return types.some((type) => creativeWorks.has(type)) ? 'work' : 'other';
}

/** The frame ratio of a subject's type, never the image's. */
export function coverRatio(types: readonly string[]): CoverRatio {
  return familyRatios[coverFamily(types)];
}

/** One ratio for a row, grid or list that mixes types: the most common one, 5:7 when tied. */
export function sharedRatio(subjects: readonly CoverSubject[]): CoverRatio {
  const counts = new Map<CoverRatio, number>();
  for (const subject of subjects) {
    const ratio = coverRatio(subject.types);
    counts.set(ratio, (counts.get(ratio) ?? 0) + 1);
  }
  let best = 0;
  let winners: CoverRatio[] = [];
  for (const [ratio, count] of counts) {
    if (count > best) [best, winners] = [count, [ratio]];
    else if (count === best) winners.push(ratio);
  }
  return winners.length === 1 ? winners[0]! : '5:7';
}

export function ratioValue(ratio: CoverRatio): number {
  const [width, height] = ratio.split(':').map(Number);
  return width! / height!;
}

/** Portraits of characters and people keep the top of the image when it is cropped. */
export function keepsTop(types: readonly string[]): boolean {
  return coverFamily(types) === 'person';
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
  return variants
    .filter((variant) => variant.format === format)
    .toSorted((a, b) => a.width - b.width)
    .map((variant) => `${src(media, format, variant.width)} ${variant.width}w`)
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
  const widths = variants
    .filter((variant) => variant.format === format)
    .map((variant) => variant.width)
    .toSorted((a, b) => a - b);
  const wanted = (size === 'fill' ? fillReferenceWidth : coverWidths[size]) * 3;
  return src(media, format, widths.find((width) => width >= wanted) ?? widths.at(-1)!);
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
