/** The site media route URL of one cover variant. */
export const coverSrc = (media: string, format: 'avif' | 'webp', width: number): string =>
  `/media/${media}/${format}-${width}`;
