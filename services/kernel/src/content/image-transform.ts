import { createHash } from 'node:crypto';
import sharp, { type OutputInfo } from 'sharp';

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
  variants: ImageVariant[];
}

/** Invalid input is permanent; callers must retry unrelated runtime failures. */
export class ImageDecodeRejection extends Error {
  readonly permanent = true;

  constructor(cause: Error) {
    super('Image cannot be decoded safely', { cause });
    this.name = 'ImageDecodeRejection';
  }
}

const inputOptions = { limitInputPixels: 40_000_000, failOn: 'warning' } as const;
const widths = [320, 640, 960, 1280, 1920, 2560] as const;

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
export async function transformImage(bytes: Uint8Array): Promise<TransformedImage> {
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

  const { width, height, channels } = decoded.info;
  const selectedWidths = width < widths[0] ? [width] : widths.filter((size) => size <= width);
  const variants: ImageVariant[] = [];
  // Sequential work bounds encoder memory and ensures no transformation remains
  // active when this function resolves or rejects.
  for (const size of selectedWidths) {
    for (const format of ['avif', 'webp'] as const) {
      const { data, info } = await sharp(decoded.data, {
        ...inputOptions,
        raw: { width, height, channels },
      })
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
  return { width, height, variants };
}
