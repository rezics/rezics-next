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
  const identity = image ? `${image.id}:${image.digest}` : null;
  const [failure, setFailure] = useState({ identity, failed: false });
  if (failure.identity !== identity) setFailure({ identity, failed: false });
  const options = { locale: locale as never };
  const unavailable = m.content_edition_image_unavailable({}, options);
  const track = useCallback(
    (element: HTMLImageElement | null) => {
      if (element?.complete && element.naturalWidth === 0) setFailure({ identity, failed: true });
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
  const available = image !== null && fallback !== null && !failure.failed;
  const sizes = '(min-width: 48rem) 65ch, calc(100vw - 3.5rem)';
  const srcSet = (values: typeof variants) =>
    image
      ? values.map((variant) => `${coverSrc(image.id, variant.format, variant.width)} ${variant.width}w`).join(', ')
      : '';
  // A failed derivative may reflect a newer disclosure decision than the page summary. Do not keep
  // source metadata visible once the image itself is unavailable.
  const credit = available ? (image?.credit ?? null) : null;
  return (
    <figure
      data-slot="document-image"
      data-state={available ? 'ready' : 'unavailable'}
      className="my-5 min-w-0 max-w-full space-y-2"
    >
      {available ? (
        <picture>
          {avif.length ? <source type="image/avif" srcSet={srcSet(avif)} sizes={sizes} /> : null}
          <img
            key={identity}
            ref={track}
            src={coverSrc(image.id, fallback.format, fallback.width)}
            srcSet={srcSet(webp.length ? webp : avif)}
            sizes={sizes}
            width={fallback.width}
            height={fallback.height}
            alt={alt}
            loading="lazy"
            decoding="async"
            className="block h-auto max-w-full rounded-xl"
            onError={() => setFailure({ identity, failed: true })}
          />
        </picture>
      ) : (
        <div
          role="img"
          aria-label={alt ? `${unavailable}: ${alt}` : unavailable}
          className="max-w-full rounded-xl bg-muted p-5 text-sm text-muted-foreground [overflow-wrap:anywhere]"
        >
          <span className="block font-medium">{unavailable}</span>
          {alt ? <span className="mt-1 block whitespace-pre-wrap [overflow-wrap:anywhere]">{alt}</span> : null}
        </div>
      )}
      {credit ? (
        <figcaption
          className="max-w-full break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
          aria-label={m.document_image_credit({}, options)}
        >
          {credit.rightsHolder} · {m.document_image_via({}, options)}{' '}
          <a
            href={credit.via.url}
            rel="noopener noreferrer nofollow ugc"
            className="break-words underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
          >
            {credit.via.name}
          </a>
          {' · '}
          {credit.license}
        </figcaption>
      ) : null}
    </figure>
  );
}
