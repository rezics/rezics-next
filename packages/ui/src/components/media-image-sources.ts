import { useCallback, useState } from 'react';

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

export interface ResolvedMediaVariant extends MediaVariant {
  src: string;
}

type Incarnated<T> = {
  key: string;
  generation: number;
  value: T;
};

/**
 * Keep state attached to the current published image incarnation. A changed key resets in the same render, and
 * the generation prevents an A-to-B-to-A transition from accepting callbacks retained by the first A.
 */
export function useIncarnationState<T>(key: string, initial: () => T) {
  const [stored, setStored] = useState<Incarnated<T>>(() => ({ key, generation: 0, value: initial() }));
  let current = stored;
  if (stored.key !== key) {
    current = { key, generation: stored.generation + 1, value: initial() };
    setStored(current);
  }
  const generation = current.generation;
  const setValue = useCallback(
    (value: T) => {
      setStored((previous) =>
        previous.key === key && previous.generation === generation && !Object.is(previous.value, value)
          ? { ...previous, value }
          : previous,
      );
    },
    [generation, key],
  );
  return { value: current.value, generation, setValue };
}

/** Resolve the summary's distinct finite published variants exactly once for this render. */
export function resolveMediaVariants(
  summary: Pick<MediaSummary, 'media' | 'variants'>,
  src: MediaSrc,
): ResolvedMediaVariant[] {
  const variants = new Map<string, MediaVariant>();
  for (const variant of summary.variants ?? []) {
    if (
      (variant.format !== 'avif' && variant.format !== 'webp') ||
      !Number.isFinite(variant.width) ||
      !Number.isInteger(variant.width) ||
      variant.width <= 0
    )
      continue;
    variants.set(`${variant.format}:${variant.width}`, { format: variant.format, width: variant.width });
  }
  return [...variants.values()]
    .toSorted((a, b) => (a.format === b.format ? a.width - b.width : a.format === 'avif' ? -1 : 1))
    .map((variant) => ({
      ...variant,
      src: src({ media: summary.media, format: variant.format, width: variant.width }),
    }));
}

/** Render source sets and a browser fallback from already-resolved published variants. */
export function mediaSourcesFromVariants(variants: readonly ResolvedMediaVariant[]): MediaSources {
  const byFormat = (['avif', 'webp'] as const)
    .map((format) => {
      const available = variants.filter((variant) => variant.format === format && variant.src.trim() !== '');
      return {
        format,
        variants: available,
        srcSet: available.map((variant) => `${variant.src} ${variant.width}w`).join(', '),
      };
    })
    .filter((entry) => entry.variants.length > 0);
  const fallback = byFormat.find((entry) => entry.format === 'webp') ?? byFormat[0];
  const largest = fallback?.variants.at(-1);
  const chosen = fallback?.variants.find((variant) => variant.width >= 640) ?? largest;
  return {
    sources: byFormat.map((entry) => ({ type: mediaTypes[entry.format], srcSet: entry.srcSet })),
    image: chosen ? { src: chosen.src, srcSet: fallback!.srcSet } : undefined,
  };
}

/** Stable identity for the published media summary and the resolver's current URLs. */
export function mediaImageIncarnation(
  summary: Pick<MediaSummary, 'media' | 'width' | 'height'> & {
    placeholder?: MediaPlaceholder | null | undefined;
  },
  variants: readonly ResolvedMediaVariant[],
): string {
  return JSON.stringify({
    media: summary.media,
    width: summary.width,
    height: summary.height,
    placeholder: [summary.placeholder?.color ?? null, summary.placeholder?.thumbhash ?? null],
    variants: variants.map((variant) => [variant.format, variant.width, variant.src]),
  });
}

/** Writes `srcset` for each format the summary has variants for; it never offers a width that was not published. */
export function mediaSources(summary: Pick<MediaSummary, 'media' | 'variants'>, src: MediaSrc): MediaSources {
  return mediaSourcesFromVariants(resolveMediaVariants(summary, src));
}
