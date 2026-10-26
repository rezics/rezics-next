/**
 * What an image in a summary needs to render, shared by `MediaImage` and any component that draws an image of the
 * same summary shape. The kernel returns the summary with the subject; the site only builds URLs from it.
 */

export interface MediaVariant {
  format: 'avif' | 'webp';
  /** Width in CSS pixels of the published variant. */
  width: number;
}

export interface MediaPlaceholder {
  /** The stored average colour as `#rrggbb`. */
  color: string;
  /** A base64 ThumbHash; kept in the shape so one summary feeds every consumer, never decoded here. */
  thumbhash?: string;
}

/** The image summary every read returns with a subject or an attachment. */
export interface MediaSummary {
  media: string;
  /** The authored crop's width when there is one, otherwise the original's. */
  width: number;
  height: number;
  placeholder?: MediaPlaceholder | null;
  /** Published variants, ordered by ascending width. */
  variants: readonly MediaVariant[];
}

/** Builds the URL of one published variant; the site owns the media route. */
export type MediaSrc = (variant: { media: string; format: MediaVariant['format']; width: number }) => string;

const formats: readonly MediaVariant['format'][] = ['avif', 'webp'];
const mediaTypes = { avif: 'image/avif', webp: 'image/webp' } as const;
const hexColor = /^#[0-9a-f]{6}$/i;

/** The placeholder colour, or `undefined` when the summary has none that is safe to paint. */
export function placeholderColor(placeholder: MediaPlaceholder | null | undefined): string | undefined {
  return placeholder && hexColor.test(placeholder.color) ? placeholder.color : undefined;
}

export interface MediaSource {
  type: (typeof mediaTypes)[MediaVariant['format']];
  srcSet: string;
}

export interface MediaSources {
  /** `<source>` entries in the order the browser tries them: AVIF before WebP. */
  sources: MediaSource[];
  /** The `<img>` fallback, from the WebP variants (or AVIF when only that exists). */
  image: { src: string; srcSet: string } | undefined;
}

/** Writes `srcset` for each format the summary has variants for; it never offers a width that was not published. */
export function mediaSources(summary: Pick<MediaSummary, 'media' | 'variants'>, src: MediaSrc): MediaSources {
  const byFormat = formats
    .map((format) => {
      const widths = [
        ...new Set(summary.variants.filter((variant) => variant.format === format).map((variant) => variant.width)),
      ]
        .filter((width) => Number.isFinite(width) && width > 0)
        .sort((a, b) => a - b);
      return {
        format,
        widths,
        srcSet: widths.map((width) => `${src({ media: summary.media, format, width })} ${width}w`).join(', '),
      };
    })
    .filter((entry) => entry.widths.length > 0);
  const fallback = byFormat.find((entry) => entry.format === 'webp') ?? byFormat[0];
  const largest = fallback?.widths.at(-1);
  // A browser without srcset support still needs one URL: the middle of the published range, never the original.
  const widest = fallback?.widths.find((width) => width >= 640) ?? largest;
  return {
    sources: byFormat.map((entry) => ({ type: mediaTypes[entry.format], srcSet: entry.srcSet })),
    image:
      fallback && widest !== undefined
        ? { src: src({ media: summary.media, format: fallback.format, width: widest }), srcSet: fallback.srcSet }
        : undefined,
  };
}
