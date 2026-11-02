'use client';

import { useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { cn } from '../utils.ts';
import {
  mediaImageIncarnation,
  mediaSourcesFromVariants,
  placeholderColor,
  resolveMediaVariants,
  useIncarnationState,
  type MediaSrc,
  type MediaSummary,
} from './media-image-sources.ts';

export interface MediaImageProps
  extends MediaSummary, Omit<ComponentProps<'span'>, 'children' | 'placeholder' | 'onError'> {
  /** Builds the URL of one published variant; the site owns the media route. */
  src: MediaSrc;
  /** The text alternative. An empty string marks the image decorative. It also fills the frame if the image fails. */
  alt: string;
  /** The `sizes` attribute: how wide the image renders at each breakpoint, so the browser picks the smallest variant. */
  sizes: string;
  /** Load now with high fetch priority, for the largest image on the page; every other image loads lazily. */
  priority?: boolean;
  /** Reports a successful browser image load without exposing the image element. */
  onImageLoad?: () => void;
  /** Reports a browser image failure without changing the admitted media source. */
  onImageError?: () => void;
  /**
   * A fixed frame ratio (width ÷ height) for tiles that must align in a gallery. The image is then cropped to the
   * frame, and the frame fills its parent instead of stopping at the image's own width.
   */
  frame?: number;
}

const positive = (value: number) => Number.isFinite(value) && value > 0;

/**
 * An image inside a document or a gallery that is not a subject cover, drawn from the same summary a cover uses.
 *
 * shadcn has no image primitive that reserves a ratio, paints a placeholder colour and offers modern formats, and
 * its `aspect-ratio` and `avatar` pieces draw a bare `<img>`. The frame holds the image's intrinsic ratio before any
 * byte arrives, so the page does not shift. It paints the stored placeholder colour while the image loads, writes
 * `<picture>` with AVIF before WebP, and replaces a failed image with a quiet frame holding the alt text, never the
 * browser's broken-image icon.
 */
export function MediaImage({
  media,
  width,
  height,
  placeholder,
  variants,
  src,
  alt,
  sizes,
  priority = false,
  onImageLoad,
  onImageError,
  frame,
  className,
  style,
  ...rest
}: MediaImageProps) {
  const image = useRef<HTMLImageElement>(null);
  const resolved = resolveMediaVariants({ media, variants }, src);
  const { sources, image: fallback } = mediaSourcesFromVariants(resolved);
  const incarnation = mediaImageIncarnation({ media, width, height, placeholder }, resolved);
  const lifetime = useIncarnationState(incarnation, () => false);
  const failed = lifetime.value || fallback === undefined;
  const intrinsic = positive(width) && positive(height);
  const ratio = frame !== undefined && positive(frame) ? frame : intrinsic ? width / height : 1;

  // A failure that happened before the handlers attached (server-rendered markup) fires no event.
  const track = useCallback(
    (element: HTMLImageElement | null) => {
      image.current = element;
      if (element?.complete && element.currentSrc) {
        const loaded = element.naturalWidth > 0;
        lifetime.setValue(!loaded);
        (loaded ? onImageLoad : onImageError)?.();
      }
    },
    [incarnation, lifetime.setValue, onImageError, onImageLoad],
  );
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.currentSrc) {
      const loaded = element.naturalWidth > 0;
      lifetime.setValue(!loaded);
      (loaded ? onImageLoad : onImageError)?.();
    }
  }, [incarnation, lifetime.setValue, onImageError, onImageLoad]);

  return (
    <span
      data-slot="media-image"
      data-state={failed ? 'unavailable' : 'image'}
      className={cn('relative block w-full overflow-hidden rounded-xl bg-muted', className)}
      style={{
        // The frame keeps its intrinsic width as a ceiling; a framed tile fills its parent.
        aspectRatio: ratio,
        maxWidth: frame === undefined && intrinsic ? width : undefined,
        backgroundColor: placeholderColor(placeholder),
        ...style,
      }}
      {...rest}
    >
      {failed ? (
        <span
          data-slot="media-image-fallback"
          role={alt ? 'img' : undefined}
          aria-label={alt || undefined}
          aria-hidden={alt ? undefined : true}
          className="absolute inset-0 grid place-items-center overflow-hidden bg-muted p-2 text-center text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]"
        >
          <span aria-hidden="true" className="line-clamp-4">
            {alt}
          </span>
        </span>
      ) : (
        <picture key={lifetime.generation} className="block size-full">
          {sources.map((source) => (
            <source key={source.type} type={source.type} srcSet={source.srcSet} sizes={sizes} />
          ))}
          <img
            ref={track}
            src={fallback.src}
            srcSet={fallback.srcSet}
            sizes={sizes}
            alt={alt}
            width={intrinsic ? width : undefined}
            height={intrinsic ? height : undefined}
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            decoding="async"
            className="block size-full object-cover"
            onLoad={(event) => {
              const loaded = event.currentTarget.naturalWidth > 0;
              lifetime.setValue(!loaded);
              (loaded ? onImageLoad : onImageError)?.();
            }}
            onError={() => {
              lifetime.setValue(true);
              onImageError?.();
            }}
          />
        </picture>
      )}
    </span>
  );
}
