import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Observe the dependency boundary while forwarding every operation to real Sharp.
const invocations: { input: unknown; options: sharp.SharpOptions | undefined }[] = [];
mock.module('sharp', () => ({
  default: (input: sharp.SharpInput, options?: sharp.SharpOptions) => {
    invocations.push({ input, options });
    return sharp(input, options);
  },
}));
const { transformImage, ImageDecodeRejection } = await import('../../src/content/image-transform');
afterEach(() => mock.restore());

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function source(width: number, height: number, orientation = 1) {
  return sharp({ create: { width, height, channels: 3, background: '#e02020' } })
    .composite([
      {
        input: await sharp({ create: { width: (width / 2) | 0, height, channels: 3, background: '#2020e0' } })
          .png()
          .toBuffer(),
        left: (width / 2) | 0,
        top: 0,
      },
    ])
    .withMetadata({ orientation })
    .withExifMerge({
      IFD0: { Artist: 'Private photographer' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '25/1 2/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '121/1 3/1 0/1' },
    })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">Private location</x:xmpmeta>')
    .jpeg()
    .toBuffer();
}

async function assertOutputs(input: Uint8Array, width: number, height: number, widths: number[]) {
  const before = Uint8Array.from(input);
  invocations.length = 0;
  const result = await transformImage(input);
  const calls = [...invocations];
  expect(sharp.versions.sharp).toMatch(/^0\.35\./);
  expect(result).toMatchObject({ width, height });
  expect(input).toEqual(before);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.options).toMatchObject({ limitInputPixels: 40_000_000, failOn: 'warning' });
  }
  expect(calls.find((call) => !call.options?.raw)?.options).toMatchObject({ autoOrient: true });
  expect(result.variants.map((item) => `${item.format}:${item.width}`).sort()).toEqual(
    widths.flatMap((size) => [`avif:${size}`, `webp:${size}`]).sort(),
  );

  for (const variant of result.variants) {
    expect(variant.bytes).toBeInstanceOf(Uint8Array);
    expect(variant.byteCount).toBe(variant.bytes.byteLength);
    expect(variant.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(variant.sha256).toBe(digest(variant.bytes));
    expect(variant.sha256).not.toBe(digest(input));
    expect(variant.mediaType).toBe(`image/${variant.format}`);
    const metadata = await sharp(variant.bytes).metadata();
    // libvips describes AVIF as HEIF with AV1 compression.
    expect(metadata.format).toBe(variant.format === 'avif' ? 'heif' : 'webp');
    if (variant.format === 'avif') expect(metadata.compression).toBe('av1');
    expect([metadata.width, metadata.height]).toEqual([variant.width, variant.height]);
    expect(variant.width).toBeLessThanOrEqual(width);
    expect(variant.height).toBe(Math.round((height * variant.width) / width));
    for (const field of ['exif', 'xmp', 'icc', 'iptc', 'orientation', 'comments'] as const) {
      expect(metadata[field]).toBeUndefined();
    }
    const decoded = await sharp(variant.bytes, { failOn: 'warning' }).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.data.length).toBe(variant.width * variant.height * decoded.info.channels);
    if (height > width) {
      const top =
        (Math.floor(variant.width / 2) + variant.width * Math.floor(variant.height / 4)) * decoded.info.channels;
      const bottom =
        (Math.floor(variant.width / 2) + variant.width * Math.floor((variant.height * 3) / 4)) * decoded.info.channels;
      expect(decoded.data[top]!).toBeGreaterThan(decoded.data[top + 2]! + 100);
      expect(decoded.data[bottom + 2]!).toBeGreaterThan(decoded.data[bottom]! + 100);
    }
  }
}

test('real Sharp emits the exact landscape ladder with decoded bytes and hashes', async () => {
  await assertOutputs(await source(3000, 1500), 3000, 1500, [320, 640, 960, 1280, 1920, 2560]);
}, 30_000);

test('EXIF 6 rotates pixels and source dimensions before selecting sanitized widths', async () => {
  const input = await source(1200, 800, 6);
  const metadata = await sharp(input).metadata();
  expect([metadata.width, metadata.height, metadata.orientation]).toEqual([1200, 800, 6]);
  // Little-endian EXIF GPSInfo pointer, latitude/longitude refs and rational tags.
  for (const tag of [0x8825, 1, 2, 3, 4]) {
    expect(metadata.exif?.includes(Buffer.from([tag & 255, tag >> 8]))).toBe(true);
  }
  expect(metadata.exif).toBeDefined();
  expect(metadata.xmp).toBeDefined();
  expect(metadata.icc).toBeDefined();
  await assertOutputs(input, 800, 1200, [320, 640]);
}, 30_000);

test('tiny inputs produce two sanitized source-width derivatives without upscaling', async () => {
  await assertOutputs(await source(127, 61), 127, 61, [127]);
});

test('overpixel, truncated intact-header and malformed bytes reject before derivative work', async () => {
  const complete = await source(1200, 800);
  const truncated = complete.subarray(0, complete.length - 100);
  expect((await sharp(truncated).metadata()).width).toBe(1200);
  const oversized = await sharp({ create: { width: 8000, height: 5001, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  expect((await sharp(oversized).metadata()).width).toBe(8000);
  for (const bytes of [oversized, truncated, new Uint8Array([1, 2, 3]), new Uint8Array()]) {
    invocations.length = 0;
    const start = performance.now();
    const rejection = await transformImage(bytes).catch((error) => error);
    expect(rejection).toBeInstanceOf(ImageDecodeRejection);
    expect(rejection.permanent).toBe(true);
    expect(rejection.cause).toBeInstanceOf(Error);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(invocations.filter((call) => call.options?.raw)).toHaveLength(0);
    expect(invocations.length).toBeLessThanOrEqual(1);
  }
}, 15_000);

test('unexpected runtime and encoder errors keep their identity', async () => {
  const input = await source(127, 61);
  const failure = new Error('Unexpected runtime failure');
  const toBuffer = spyOn(sharp.prototype, 'toBuffer').mockImplementation(() => {
    throw failure;
  });
  await expect(transformImage(input)).rejects.toBe(failure);
  toBuffer.mockRestore();
  const encoderFailure = new Error('Encoder resource unavailable');
  spyOn(sharp.prototype, 'avif').mockImplementation(() => {
    throw encoderFailure;
  });
  await expect(transformImage(input)).rejects.toBe(encoderFailure);
});
