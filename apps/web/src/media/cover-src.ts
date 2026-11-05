/** The site media route URL of one cover variant. */
export const coverSrc = (media: string, format: 'avif' | 'webp', width: number): string =>
  `/media/${media}/${format}-${width}`;

/** The variant addresses accepted by the site's media transport. */
export function validVariant(variant: string): boolean {
  if (variant === 'original') return true;
  const match = /^(webp|avif)-([1-9][0-9]{0,3})$/.exec(variant);
  if (!match || match[0] !== variant) return false;
  const width = Number(match[2]);
  return width < 320 || [320, 640, 960, 1280, 1920, 2560].includes(width);
}
