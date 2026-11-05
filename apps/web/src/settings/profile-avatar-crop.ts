import type { UploadRefusalReason } from '../threads/upload';

export const avatarUploadByteLimit = 20 * 1024 * 1024;
export const avatarCropOutputLimit = 512;
const avatarCropSourceDimensionLimit = 16_384;
const avatarCropSourcePixelLimit = 40_000_000;
const acceptedAvatarTypes = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);

export type AvatarCropPosition = {
  horizontal: number;
  vertical: number;
  zoom: number;
};

export type AvatarCropSource = {
  width: number;
  height: number;
};

export type AvatarCropIssue = 'unsupported' | 'decode' | 'encode';

export const initialAvatarCrop: AvatarCropPosition = { horizontal: 50, vertical: 50, zoom: 100 };

/** Match the existing avatar uploader's accepted type, byte-count and empty-file bounds before local decode. */
export function avatarUploadFailure(file: File): UploadRefusalReason | undefined {
  if (!acceptedAvatarTypes.has(file.type)) return 'type';
  if (!Number.isSafeInteger(file.size) || file.size < 1) return 'unavailable';
  if (file.size > avatarUploadByteLimit) return 'too-large';
  return undefined;
}

export function avatarCropSourceSupported(source: AvatarCropSource): boolean {
  return (
    Number.isSafeInteger(source.width) &&
    Number.isSafeInteger(source.height) &&
    source.width > 0 &&
    source.height > 0 &&
    source.width <= avatarCropSourceDimensionLimit &&
    source.height <= avatarCropSourceDimensionLimit &&
    source.width * source.height <= avatarCropSourcePixelLimit
  );
}

export function avatarCropMaxZoom(source: AvatarCropSource): number {
  return Math.max(100, Math.min(300, Math.floor(Math.min(source.width, source.height) * 100)));
}

export function constrainAvatarCrop(source: AvatarCropSource, position: AvatarCropPosition): AvatarCropPosition {
  return {
    horizontal: Math.max(0, Math.min(100, Math.round(position.horizontal))),
    vertical: Math.max(0, Math.min(100, Math.round(position.vertical))),
    zoom: Math.max(100, Math.min(avatarCropMaxZoom(source), Math.round(position.zoom / 10) * 10)),
  };
}

export function avatarCropBounds(source: AvatarCropSource, position: AvatarCropPosition) {
  const crop = constrainAvatarCrop(source, position);
  const side = Math.min(source.width, source.height) / (crop.zoom / 100);
  return {
    side,
    x: ((source.width - side) * crop.horizontal) / 100,
    y: ((source.height - side) * crop.vertical) / 100,
  };
}

export async function decodeAvatarCrop(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function') return null;
  return createImageBitmap(file);
}

/** Export one square PNG from a fixed-size canvas. The crop never upscales source pixels. */
export async function createCroppedAvatarFile(
  bitmap: ImageBitmap,
  sourceFile: File,
  position: AvatarCropPosition,
): Promise<File> {
  const bounds = avatarCropBounds(bitmap, position);
  const size = Math.max(1, Math.min(avatarCropOutputLimit, Math.floor(bounds.side)));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas context is unavailable');
    context.drawImage(bitmap, bounds.x, bounds.y, bounds.side, bounds.side, 0, 0, size, size);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('Canvas export failed'))), 'image/png');
    });
    if (blob.size > avatarUploadByteLimit) throw new Error('Cropped image exceeds the avatar upload limit');
    const name = sourceFile.name.replace(/\.[^.]*$/, '') || 'avatar';
    return new File([blob], `${name}-crop.png`, { type: 'image/png', lastModified: sourceFile.lastModified });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
