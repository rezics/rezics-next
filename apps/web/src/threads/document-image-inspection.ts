import { coverSrc } from '../media/cover-src';
import type { DocumentImagePresentation } from './document-media';

export type DocumentImageInspectionMode = 'fit' | 'actual';
export type DocumentImageInspectionVariant = Readonly<{
  format: 'avif' | 'webp';
  width: number;
  height: number;
  src: string;
}>;

/** Select one admitted derivative for this explicit visit; never inspect or sort another image's variants. */
export function selectDocumentImageInspectionVariant(
  image: DocumentImagePresentation,
): DocumentImageInspectionVariant | null {
  let largest: DocumentImagePresentation['variants'][number] | null = null;
  let largestArea = -1;
  for (const variant of image.variants) {
    const area = Math.log(variant.width) + Math.log(variant.height);
    if (
      !largest ||
      area > largestArea ||
      (area === largestArea && variant.format === 'webp' && largest.format !== 'webp')
    ) {
      largest = variant;
      largestArea = area;
    }
  }
  return largest ? { ...largest, src: coverSrc(image.id, largest.format, largest.width) } : null;
}
