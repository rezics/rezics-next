import { createHash } from 'node:crypto';
import sharp, { type OutputInfo } from 'sharp';
import { rgbaToThumbHash, thumbHashToAverageRGBA } from 'thumbhash';

export interface ImageVariant {
  format: 'avif' | 'webp';
  width: number;
  height: number;
  mediaType: 'image/avif' | 'image/webp';
  bytes: Uint8Array;
  byteCount: number;
  sha256: string;
}

export interface TransformedImage {
  /** Source dimensions after applying EXIF orientation. */
  width: number;
  height: number;
  thumbhash: Uint8Array;
  averageColor: string;
  variants: ImageVariant[];
}
export type ImageCrop = readonly [left: number, top: number, width: number, height: number];

/** Invalid input is permanent; callers must retry unrelated runtime failures. */
export class ImageDecodeRejection extends Error {
  readonly permanent = true;

  constructor(cause: Error) {
    super('Image cannot be decoded safely', { cause });
    this.name = 'ImageDecodeRejection';
  }
}

/** An authored crop is valid syntax but does not fit the auto-oriented image. */
export class ImageCropOutOfBoundsRejection extends Error {
  readonly permanent = true;

  constructor() {
    super('Image crop is outside the decoded image');
    this.name = 'ImageCropOutOfBoundsRejection';
  }
}

const inputOptions = { limitInputPixels: 40_000_000, failOn: 'warning' } as const;
const widths = [320, 640, 960, 1280, 1920, 2560] as const;

type DecodedPixels = { data: Buffer; info: OutputInfo };

/** Start each derivative from the single oriented decode; a future crop belongs before the output resize. */
function decodedImage(decoded: DecodedPixels) {
  const { width, height, channels } = decoded.info;
  return sharp(decoded.data, { ...inputOptions, raw: { width, height, channels } });
}

function isDecodeFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  // Sharp exposes native decoder errors as plain Errors. Only recognize input
  // diagnostics; resource, programming and encoder failures keep their identity.
  if ('code' in error || /memory|allocation|resource|system error/i.test(error.message)) return false;
  return (
    /^(?:Input (?:Buffer|[Bb]it Array) is empty$|Input buffer contains unsupported image format$|Input buffer has corrupt header:|Input image exceeds (?:pixel|channel) limit$)/.test(
      error.message,
    ) ||
    /^(?:VipsJpeg|vipspng|(?:jpeg|png|webp|gif|heif|tiff)(?:load)?(?:_buffer)?):[^\n]*(?:corrupt|premature|truncat|invalid|unexpected end|read error|end of stream)/im.test(
      error.message,
    )
  );
}

/** In-memory transformation only: no original bytes are returned as derivatives. */
export async function transformImage(bytes: Uint8Array, crop?: ImageCrop | null): Promise<TransformedImage> {
  let decoded: { data: Buffer; info: OutputInfo };
  try {
    // Fully decode once before fan-out. Raw pixels bound memory by the input
    // pixel limit and carry no EXIF, GPS, XMP, ICC or other source metadata.
    decoded = await sharp(bytes, { ...inputOptions, autoOrient: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (isDecodeFailure(error)) throw new ImageDecodeRejection(error);
    throw error;
  }

  const { width, height } = decoded.info;
  let image = decoded;
  if (crop) {
    const [left, top, cropWidth, cropHeight] = crop;
    if (
      ![left, top, cropWidth, cropHeight].every(Number.isSafeInteger) ||
      left < 0 ||
      top < 0 ||
      cropWidth < 1 ||
      cropHeight < 1
    )
      throw new TypeError('Invalid image crop');
    if (left > width - cropWidth || top > height - cropHeight) throw new ImageCropOutOfBoundsRejection();
    image = await decodedImage(decoded)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .raw()
      .toBuffer({ resolveWithObject: true });
  }
  const outputWidth = image.info.width;
  const selectedWidths = outputWidth < widths[0] ? [outputWidth] : widths.filter((size) => size <= outputWidth);
  const placeholder = await decodedImage(image)
    .resize({ width: 100, height: 100, fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const thumbhash = rgbaToThumbHash(placeholder.info.width, placeholder.info.height, placeholder.data);
  const average = thumbHashToAverageRGBA(thumbhash);
  const averageColor = `#${[average.r, average.g, average.b]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
  const variants: ImageVariant[] = [];
  // Sequential work bounds encoder memory and ensures no transformation remains
  // active when this function resolves or rejects.
  for (const size of selectedWidths) {
    for (const format of ['avif', 'webp'] as const) {
      const { data, info } = await decodedImage(image)
        .resize({ width: size, withoutEnlargement: true })
        .toFormat(format)
        .toBuffer({ resolveWithObject: true });
      variants.push({
        format,
        width: info.width,
        height: info.height,
        mediaType: `image/${format}`,
        bytes: data,
        byteCount: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
    }
  }
  return { width, height, thumbhash, averageColor, variants };
}
