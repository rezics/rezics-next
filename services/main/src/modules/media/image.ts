/** Header-only verification of an admitted still-image upload. No decoder runs. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface VerifiedImage {
  mediaType: ImageMediaType;
  width: number;
  height: number;
}

export class ImageFormatRejected extends Error {}

const MAX_DIMENSION = 16_384;

function checked(mediaType: ImageMediaType, width: number, height: number): VerifiedImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ImageFormatRejected('image dimensions are outside the admitted range');
  }
  return { mediaType, width, height };
}

function jpegSize(bytes: Uint8Array): VerifiedImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Walk bounded marker segments to the first start-of-frame header.
  let offset = 2;
  for (let segments = 0; segments < 512 && offset + 9 <= bytes.length; segments++) {
    if (bytes[offset] !== 0xff) throw new ImageFormatRejected('JPEG marker is malformed');
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) throw new ImageFormatRejected('JPEG segment is malformed');
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return checked('image/jpeg', view.getUint16(offset + 7), view.getUint16(offset + 5));
    }
    offset += 2 + length;
  }
  throw new ImageFormatRejected('JPEG frame header is missing');
}

function webpSize(bytes: Uint8Array): VerifiedImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X' && bytes.length >= 30) {
    const width = 1 + (bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16);
    const height = 1 + (bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16);
    return checked('image/webp', width, height);
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return checked('image/webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = view.getUint32(21, true);
    return checked('image/webp', (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  throw new ImageFormatRejected('WebP header is unsupported');
}

/** Sniff the actual container, which must match the declared media type. */
export function verifyImage(bytes: Uint8Array, declared: string): VerifiedImage {
  let image: VerifiedImage;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a
    && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR') {
    image = checked('image/png', view.getUint32(16), view.getUint32(20));
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    image = jpegSize(bytes);
  } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))) {
    image = checked('image/gif', view.getUint16(6, true), view.getUint16(8, true));
  } else if (bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    image = webpSize(bytes);
  } else {
    throw new ImageFormatRejected('bytes are not an admitted image format');
  }
  if (image.mediaType !== declared) throw new ImageFormatRejected('declared media type differs from the bytes');
  return image;
}
