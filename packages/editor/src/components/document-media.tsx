import { Button } from '@rezics/ui/shadcn/button';
import { useState, type ReactNode } from 'react';

/** Authored occurrence facts, independent of permission to resolve the referenced media. */
export type DocumentImageOccurrence = Readonly<{
  id: string;
  src: string;
  /** Alias retained for existing reader callbacks. */
  mediaId: string;
  alt: string;
  title: string | null;
  width: number | null;
  height: number | null;
  conceal: boolean;
}>;
export type DocumentMediaOccurrence = Readonly<{
  id: string;
  src: string;
  kind: 'audio' | 'video' | 'file';
  caption: string;
}>;
/** Null means no admitted presentation; an editor may still have an accepted visit-owned local preview. */
export type DocumentImageRenderer = (image: DocumentImageOccurrence) => ReactNode;
export type DocumentMediaRenderer = (media: DocumentMediaOccurrence) => ReactNode;

type Attributed = { attrs?: Readonly<Record<string, unknown>> };
const dimension = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

export function documentImageOccurrence(node: Attributed): DocumentImageOccurrence {
  const attrs = node.attrs ?? {};
  const src = typeof attrs.src === 'string' ? attrs.src : '';
  return {
    id: typeof attrs.id === 'string' ? attrs.id : '',
    src,
    mediaId: src,
    alt: typeof attrs.alt === 'string' ? attrs.alt : '',
    title: typeof attrs.title === 'string' ? attrs.title : null,
    width: dimension(attrs.width),
    height: dimension(attrs.height),
    conceal: attrs.conceal === true,
  };
}

export function documentMediaOccurrence(node: Attributed): DocumentMediaOccurrence {
  const attrs = node.attrs ?? {};
  return {
    id: typeof attrs.id === 'string' ? attrs.id : '',
    src: typeof attrs.src === 'string' ? attrs.src : '',
    kind: attrs.kind === 'audio' || attrs.kind === 'video' ? attrs.kind : 'file',
    caption: typeof attrs.caption === 'string' ? attrs.caption : '',
  };
}

export function imageOccurrenceKey(image: DocumentImageOccurrence): string {
  return JSON.stringify([image.id, image.src, image.alt, image.title, image.width, image.height, image.conceal]);
}

/** No resolver is invoked before this occurrence's authored concealment is deliberately revealed. */
export function DocumentImageView({
  image,
  renderImage,
  unavailable,
  reveal,
  isCurrent = () => true,
}: {
  image: DocumentImageOccurrence;
  renderImage?: DocumentImageRenderer;
  unavailable: string;
  reveal: string;
  isCurrent?: () => boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div
      data-slot="document-image-occurrence"
      data-occurrence-id={image.id}
      style={{ maxWidth: '100%', ...(image.width ? { width: image.width } : {}) }}
      title={image.title ?? undefined}
    >
      {image.conceal && !revealed ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 max-w-full whitespace-normal"
          onClick={() => {
            if (isCurrent()) setRevealed(true);
          }}
        >
          {reveal}
          {image.alt ? ` — ${image.alt}` : ''}
        </Button>
      ) : (
        (renderImage?.(image) ?? (
          <div
            role="img"
            aria-label={image.alt || unavailable}
            className="rounded-xl bg-muted p-4 text-sm text-muted-foreground [overflow-wrap:anywhere]"
          >
            {unavailable}
            {image.alt ? ` — ${image.alt}` : ''}
          </div>
        ))
      )}
    </div>
  );
}

export function DocumentMediaView({
  media,
  renderMedia,
  unavailable,
}: {
  media: DocumentMediaOccurrence;
  renderMedia?: DocumentMediaRenderer;
  unavailable: string;
}) {
  return (
    <figure
      data-slot="document-media-occurrence"
      data-occurrence-id={media.id}
      className="min-w-0 max-w-full space-y-2"
    >
      {renderMedia?.(media) ?? (
        <div role="group" aria-label={unavailable} className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
          {unavailable}
        </div>
      )}
      {media.caption ? (
        <figcaption className="whitespace-pre-wrap [overflow-wrap:anywhere]">{media.caption}</figcaption>
      ) : null}
    </figure>
  );
}
