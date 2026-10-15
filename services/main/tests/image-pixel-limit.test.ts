import { expect, test } from 'bun:test';
import { ImageFormatRejected, ImagePixelLimitExceeded, MAX_IMAGE_PIXELS, verifyImage,
  type ImageMediaType } from '../src/modules/media/image.ts';

/** Only container headers: refusing their dimensions cannot require a decoder. */
function headers(width: number, height: number): Array<[ImageMediaType, Uint8Array]> {
  const png = new Uint8Array(24), gif = new Uint8Array(10), jpeg = new Uint8Array(11);
  const webp = new Uint8Array(30), lossless = new Uint8Array(25), lossy = new Uint8Array(30);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.set(new TextEncoder().encode('IHDR'), 12);
  new DataView(png.buffer).setUint32(16, width);
  new DataView(png.buffer).setUint32(20, height);
  gif.set(new TextEncoder().encode('GIF89a'));
  new DataView(gif.buffer).setUint16(6, width, true);
  new DataView(gif.buffer).setUint16(8, height, true);
  jpeg.set([255, 216, 255, 192, 0, 9, 8]);
  new DataView(jpeg.buffer).setUint16(7, height);
  new DataView(jpeg.buffer).setUint16(9, width);
  for (const [bytes, chunk] of [[webp, 'VP8X'], [lossless, 'VP8L'], [lossy, 'VP8 ']] as const) {
    bytes.set(new TextEncoder().encode('RIFF'));
    bytes.set(new TextEncoder().encode(`WEBP${chunk}`), 8);
  }
  webp.set([width - 1 & 255, (width - 1) >> 8 & 255, (width - 1) >> 16], 24);
  webp.set([height - 1 & 255, (height - 1) >> 8 & 255, (height - 1) >> 16], 27);
  lossless[20] = 0x2f;
  new DataView(lossless.buffer).setUint32(21, (width - 1) | (height - 1) << 14, true);
  lossy.set([0x9d, 0x01, 0x2a], 23);
  new DataView(lossy.buffer).setUint16(26, width, true);
  new DataView(lossy.buffer).setUint16(28, height, true);
  return [['image/png', png], ['image/gif', gif], ['image/jpeg', jpeg],
    ['image/webp', webp], ['image/webp', lossless], ['image/webp', lossy]];
}

test('every original image header refuses excessive pixels before decoding, including non-square images', () => {
  expect(MAX_IMAGE_PIXELS).toBe(8192 * 4096);
  for (const [mediaType, bytes] of headers(8192, 4096)) {
    expect(verifyImage(bytes, mediaType)).toEqual({ mediaType, width: 8192, height: 4096 });
  }
  for (const [width, height] of [[8192, 4097], [4097, 8192], [16_383, 16_383]] as const) {
    for (const [mediaType, bytes] of headers(width, height)) {
      expect(bytes.length).toBeLessThanOrEqual(30);
      expect(() => verifyImage(bytes, mediaType)).toThrow(ImagePixelLimitExceeded);
      expect(() => verifyImage(bytes, mediaType)).toThrow(ImageFormatRejected);
    }
  }
});
