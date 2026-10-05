// What the editor checks about a chosen file before anything is uploaded: a type Main stores, a
// size and pixel count within Main's upload and rendition limits, and, for logos and cutouts, an
// alpha channel. Main checks the same things again and refuses with its own problem codes; these
// checks only spare a person an upload that could not be used.

/** Main's upload limit for one image (`MAX_UPLOAD_BYTES`) and its rendition bounds (`RENDITION_LIMITS`). */
export const IMAGE_LIMITS = { bytes: 8 * 1024 * 1024, pixels: 32 * 1024 * 1024, dimension: 16_384 } as const;

/** Backgrounds may be photographs; logos and cutouts must be able to carry transparency. */
export const acceptedTypes = {
  background: ['image/jpeg', 'image/png', 'image/webp'],
  layer: ['image/png', 'image/webp'],
} as const;

export type FileProblem = 'type' | 'bytes' | 'pixels' | 'unreadable' | 'alpha';

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));
const uint32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

/**
 * Whether the encoded image declares an alpha channel, read from its header as Main's decoder
 * (libvips through sharp, `hasAlpha`) reads it. A PNG has one with a grey+alpha or RGBA colour type
 * or a `tRNS` chunk; a WebP with the VP8X alpha flag or the VP8L `alpha_is_used` bit. An alpha
 * channel counts even when every pixel is opaque, as Main admits it. JPEG never has one.
 */
export function declaresAlpha(bytes: Uint8Array): boolean {
  if (bytes.length >= 33 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') {
    const colourType = bytes[25];
    if (colourType === 4 || colourType === 6) return true;
    for (let at = 8; at + 8 <= bytes.length;) {
      const length = uint32(bytes, at);
      const type = ascii(bytes, at + 4, 4);
      if (type === 'tRNS') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      at += 12 + length;
    }
    return false;
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X') return (bytes[20]! & 0x10) !== 0;
    if (chunk === 'VP8L') return bytes[20] === 0x2f && (bytes[24]! & 0x10) !== 0;
    return false;
  }
  return false;
}

/** The problem with a file's type or byte size for a role, before it is decoded. */
export function fileProblem(file: Pick<File, 'type' | 'size'>, kind: keyof typeof acceptedTypes): FileProblem | null {
  if (!(acceptedTypes[kind] as readonly string[]).includes(file.type)) return 'type';
  if (!file.size || file.size > IMAGE_LIMITS.bytes) return 'bytes';
  return null;
}

/** The problem with decoded pixel dimensions, which Main's renditions bound. */
export const pixelProblem = (size: { width: number; height: number }): FileProblem | null =>
  !size.width || !size.height ? 'unreadable'
    : size.width > IMAGE_LIMITS.dimension || size.height > IMAGE_LIMITS.dimension
      || size.width * size.height > IMAGE_LIMITS.pixels ? 'pixels' : null;
