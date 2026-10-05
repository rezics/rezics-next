/** A versioned encoding profile fixes both width and codec; crops remain Use data. */
export const RENDITION_WIDTHS = [320, 640, 960, 1280, 1920, 2560] as const;
export const RENDITION_TYPES = ['image/avif', 'image/webp'] as const;
export type RenditionType = (typeof RENDITION_TYPES)[number];
export const RENDITION_LIMITS = {
  bytes: 8 * 1024 * 1024,
  pixels: 32 * 1024 * 1024,
  dimension: 16_384,
  timeoutMs: 30_000,
  leaseMs: 60_000,
  attempts: 16,
  batch: 64,
  candidates: RENDITION_WIDTHS.length * RENDITION_TYPES.length,
} as const;
export interface ImageSize {
  width: number;
  height: number;
}
export interface PixelCrop extends ImageSize {
  left: number;
  top: number;
}
export interface RenditionPlan {
  profile: string;
  crop: string | null;
}
export interface RenditionOutput extends ImageSize {
  bytes: Uint8Array;
  type: RenditionType;
}
export interface RenditionCandidate extends ImageSize {
  url: string;
  type: RenditionType;
}

export function checkSize(size: ImageSize): void {
  if (
    ![size.width, size.height].every(
      (value) => Number.isInteger(value) && value > 0 && value <= RENDITION_LIMITS.dimension,
    ) ||
    size.width * size.height > RENDITION_LIMITS.pixels
  ) {
    throw new Error('rendition pixel bound');
  }
}

/** Percent coordinates address oriented pixels. Round the origin down and the
 * extent up, retaining even subpixel crops, then clamp the last boundary. */
export function pixelCrop(crop: string | null, size: ImageSize): PixelCrop {
  checkSize(size);
  if (crop === null) return { left: 0, top: 0, ...size };
  if (!/^xywh=percent:([0-9]{1,3}(\.[0-9]{1,3})?,){3}[0-9]{1,3}(\.[0-9]{1,3})?$/.test(crop)) {
    throw new Error('invalid rendition crop');
  }
  // Thousandths avoid rejecting a valid boundary through floating-point sums.
  const [x, y, w, h] = crop
    .slice('xywh=percent:'.length)
    .split(',')
    .map((value) => Math.round(Number(value) * 1000));
  if (w! <= 0 || h! <= 0 || x! + w! > 100_000 || y! + h! > 100_000)
    throw new Error('invalid rendition crop');
  const left = Math.floor((x! * size.width) / 100_000);
  const top = Math.floor((y! * size.height) / 100_000);
  return {
    left,
    top,
    width: Math.min(size.width - left, Math.ceil((w! * size.width) / 100_000)),
    height: Math.min(size.height - top, Math.ceil((h! * size.height) / 100_000)),
  };
}

/** The final step clips to native crop width, so small images also get candidates. */
export function renditionProfiles(croppedWidth: number): string[] {
  if (
    !Number.isInteger(croppedWidth) ||
    croppedWidth < 1 ||
    croppedWidth > RENDITION_LIMITS.dimension
  ) {
    throw new Error('invalid rendition width');
  }
  return [...new Set(RENDITION_WIDTHS.map((width) => Math.min(width, croppedWidth)))].flatMap(
    (width) =>
      RENDITION_TYPES.map((type) => `image-width-${width}-${type.slice('image/'.length)}-v1`),
  );
}

export function parseProfile(profile: string): { width: number; type: RenditionType } {
  const match = /^image-width-([1-9][0-9]{0,3})-(avif|webp)-v1$/.exec(profile);
  const width = Number(match?.[1]);
  if (!match || width > RENDITION_WIDTHS.at(-1)!) throw new Error('invalid rendition profile');
  return { width, type: `image/${match[2]}` as RenditionType };
}
