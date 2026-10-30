import { useCallback, useState } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import type { DocumentImagePresentation } from './document-media';

/** Render only delivered derivative facts. The existing Worker route independently authorizes the bytes. */
export function NativeDocumentImage({
  image,
  alt,
  locale,
}: {
  image: DocumentImagePresentation | null;
  alt: string;
  locale: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const options = { locale: locale as never };
  const unavailable = m.content_edition_image_unavailable({}, options);
  const identity = image ? `${image.id}:${image.digest}` : null;
  const track = useCallback(
    (element: HTMLImageElement | null) => {
      if (element?.complete && element.naturalWidth === 0) setFailed(identity);
    },
    [identity],
  );
  const variants = image?.variants ?? [];
  const webp = variants.filter((variant) => variant.format === 'webp');
  const avif = variants.filter((variant) => variant.format === 'avif');
  const fallback = (webp.length ? webp : avif).reduce<(typeof variants)[number] | null>(
    (largest, variant) => (!largest || variant.width > largest.width ? variant : largest),
    null,
  );
  const available = image !== null && fallback !== null && failed !== identity;
  const sizes = '(min-width: 48rem) 65ch, calc(100vw - 3.5rem)';
  const srcSet = (values: typeof variants) =>
    image
      ? values.map((variant) => `${coverSrc(image.id, variant.format, variant.width)} ${variant.width}w`).join(', ')
      : '';
  const credit = image?.credit;
  return (
    <figure data-slot="document-image" data-state={available ? 'ready' : 'unavailable'} className="my-5 space-y-2">
      {available ? (
        <picture>
          {avif.length ? <source type="image/avif" srcSet={srcSet(avif)} sizes={sizes} /> : null}
          <img
            ref={track}
            src={coverSrc(image.id, fallback.format, fallback.width)}
            srcSet={srcSet(webp.length ? webp : avif)}
            sizes={sizes}
            width={fallback.width}
            height={fallback.height}
            alt={alt}
            loading="lazy"
            decoding="async"
            className="h-auto max-w-full rounded-xl"
            onError={() => setFailed(identity)}
          />
        </picture>
      ) : (
        <div
          role="img"
          aria-label={alt || unavailable}
          className="rounded-xl bg-muted p-5 text-sm text-muted-foreground"
        >
          {unavailable}
          {alt ? ` — ${alt}` : ''}
        </div>
      )}
      {credit ? (
        <figcaption className="text-sm text-muted-foreground" aria-label={m.document_image_credit({}, options)}>
          {credit.rightsHolder} · {m.document_image_via({}, options)}{' '}
          <a href={credit.via.url} rel="noopener noreferrer nofollow ugc">
            {credit.via.name}
          </a>
          {' · '}
          {credit.license}
        </figcaption>
      ) : null}
    </figure>
  );
}
