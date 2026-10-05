import type { PixelRect, Size } from './frame.ts';

/** A preview never needs more pixels than the widest stage asks for. */
const WIDEST = 1920;

/**
 * Draws a frame of an image at preview size, for the stage, which shows whole images and cannot
 * crop. Only the preview uses it: Main keeps the original and renders the frame itself.
 */
export async function drawFrame(src: string, frame: PixelRect, size: Size): Promise<{ url: string; size: Size } | null> {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  try { await image.decode(); } catch { return null; }
  // The frame is in the pixels Main measured; a decoder that sizes the image otherwise (SVG) is scaled to them.
  const scale = image.naturalWidth / size.width;
  const width = Math.min(frame.width, WIDEST);
  const height = Math.round((width * frame.height) / frame.width);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, frame.left * scale, frame.top * scale, frame.width * scale, frame.height * scale, 0, 0, width, height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.86));
  return blob ? { url: URL.createObjectURL(blob), size: { width, height } } : null;
}

/** An image's oriented size, as the browser decodes it and Main inspects it; null when it cannot be decoded. */
export async function decodedSize(src: string): Promise<Size | null> {
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    return null;
  }
}
