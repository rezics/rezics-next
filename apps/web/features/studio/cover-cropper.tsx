'use client';

import { ImageCropperImage, ImageCropperRootProvider, ImageCropperSelection, useImageCropper }
  from '@rezics/ui/image-cropper';
import { useEffect } from 'react';
import { COVER_MAX_BYTES } from './cover-api.ts';

// The longest side Studio sends; readers get at most 2048 px, and a cover is shown far smaller.
const LONG_SIDE = 1800;

/** Frames a picture to the cover's proportions and crops it to what readers are shown. */
export function CoverCropper({ source, ratio, label, onReady }: {
  source: { url: string; width: number; height: number }; ratio: number; label: string;
  onReady: (crop: () => Promise<Blob | null>) => void;
}) {
  const cropper = useImageCropper({ aspectRatio: ratio });
  useEffect(() => {
    onReady(async () => {
      const size = ratio >= 1 ? { width: LONG_SIDE, height: Math.round(LONG_SIDE / ratio) }
        : { width: Math.round(LONG_SIDE * ratio), height: LONG_SIDE };
      for (const quality of [0.9, 0.8, 0.7]) {
        const image = await cropper.getCroppedImage({ type: 'image/jpeg', quality, maxSize: size, output: 'blob' });
        if (!(image instanceof Blob)) return null;
        if (image.size <= COVER_MAX_BYTES) return image;
      }
      return null;
    });
  }, [cropper, ratio, onReady]);
  // The frame takes the picture's own proportions, so the picture is never stretched; tall pictures fit the screen.
  const shape = source.width / source.height;
  return <ImageCropperRootProvider value={cropper} aria-label={label} className="mx-auto rounded-2xl bg-muted"
    style={{ aspectRatio: String(shape), maxWidth: `min(100%, calc(60dvh * ${shape}))` }}>
    <ImageCropperImage src={source.url} alt="" />
    <ImageCropperSelection />
  </ImageCropperRootProvider>;
}
