import type { CoverSummary } from '@rezics/ui/cover';
import { coverSrc } from './cover-src';

export type PublicCardImage = { url: string; width: number; height: number; alt: string };

/** Only variants the anonymous page can display may enter a public head or its preload. */
export function publicCover(cover: CoverSummary | null | undefined): CoverSummary | undefined {
  if (
    !cover ||
    cover.withheld ||
    !cover.media ||
    !Number.isFinite(cover.width) ||
    !Number.isFinite(cover.height) ||
    cover.width <= 0 ||
    cover.height <= 0
  )
    return;
  const variants = cover.variants.filter(
    (variant) =>
      (variant.format === 'avif' || variant.format === 'webp') &&
      Number.isSafeInteger(variant.width) &&
      variant.width > 0,
  );
  return variants.length ? { ...cover, variants } : undefined;
}

/** The largest supplied public variant, preferring WebP at equal widths for sharing clients. */
export function publicCardImage(cover: CoverSummary | null | undefined, alt: string): PublicCardImage | undefined {
  const visible = publicCover(cover);
  if (!visible) return;
  const variant = visible.variants.reduce((current, next) =>
    next.width > current.width || (next.width === current.width && next.format === 'webp') ? next : current,
  );
  return {
    url: coverSrc(visible.media, variant.format, variant.width),
    width: variant.width,
    height: Math.max(1, Math.round((visible.height * variant.width) / visible.width)),
    alt,
  };
}
