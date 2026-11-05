import { useCallback, useRef, useState } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import type { DocumentImagePresentation } from './document-media';
import { DocumentImageInspector } from './document-image-inspector';

type DocumentImageProps = {
  image: DocumentImagePresentation | null;
  alt: string;
  locale: string;
  /** Callers without a mounted disclosed-reader lifetime can leave inspection disabled. */
  inspectable?: boolean;
};

/** Render only delivered derivative facts. The existing Worker route independently authorizes the bytes. */
export function NativeDocumentImage(props: DocumentImageProps) {
  const { image } = props;
  // Replacing any supplied presentation fact or its alt text retires image and inspector callbacks together.
  const identity = image?.variants.length ? JSON.stringify([image, props.alt]) : 'unavailable';
  return <DocumentImageDisclosure key={identity} {...props} />;
}

function DocumentImageDisclosure({ image, alt, locale, inspectable = true }: DocumentImageProps) {
  const [phase, setPhase] = useState<'initial' | 'ready' | 'failed' | 'retrying'>('initial');
  const current = useRef<HTMLImageElement | null>(null);
  const options = { locale: locale as never };
  const unavailable = m.content_edition_image_unavailable({}, options);
  const settle = useCallback((element: HTMLImageElement, result: 'ready' | 'failed') => {
    // Detached attempts cannot reveal credit or fail a later attempt. Failure is terminal until Retry.
    if (current.current !== element) return;
    setPhase((previous) => (previous === 'failed' ? previous : result));
  }, []);
  const track = useCallback(
    (element: HTMLImageElement | null) => {
      current.current = element;
      // A cached success or failure may finish before React attaches the browser event handlers.
      if (element?.complete) settle(element, element.naturalWidth > 0 ? 'ready' : 'failed');
    },
    [settle],
  );
  const variants = image?.variants ?? [];
  const webp = variants.filter((variant) => variant.format === 'webp');
  const avif = variants.filter((variant) => variant.format === 'avif');
  const fallback = (webp.length ? webp : avif).reduce<(typeof variants)[number] | null>(
    (largest, variant) => (!largest || variant.width > largest.width ? variant : largest),
    null,
  );
  const admitted = image !== null && fallback !== null;
  const recovering = phase === 'retrying';
  const available = admitted && phase !== 'failed' && !recovering;
  const sizes = '(min-width: 48rem) 65ch, calc(100vw - 3.5rem)';
  const srcSet = (values: typeof variants) =>
    image
      ? values.map((variant) => `${coverSrc(image.id, variant.format, variant.width)} ${variant.width}w`).join(', ')
      : '';
  // A failed derivative may reflect a newer disclosure decision than the page summary. Do not keep
  // source metadata visible once the image itself is unavailable.
  const credit = available ? (image?.credit ?? null) : null;
  const retry = () => setPhase((previous) => (previous === 'failed' ? 'retrying' : previous));
  return (
    <figure
      data-slot="document-image"
      data-state={available ? 'ready' : 'unavailable'}
      aria-busy={recovering || undefined}
      className="my-5 min-w-0 max-w-full space-y-2"
    >
      {admitted && phase !== 'failed' ? (
        <picture hidden={recovering}>
          {avif.length ? <source type="image/avif" srcSet={srcSet(avif)} sizes={sizes} /> : null}
          <img
            ref={track}
            src={coverSrc(image.id, fallback.format, fallback.width)}
            srcSet={srcSet(webp.length ? webp : avif)}
            sizes={sizes}
            width={fallback.width}
            height={fallback.height}
            alt={alt}
            loading={recovering ? 'eager' : 'lazy'}
            decoding="async"
            className="block h-auto max-w-full rounded-xl"
            onLoad={(event) => settle(event.currentTarget, 'ready')}
            onError={(event) => settle(event.currentTarget, 'failed')}
          />
        </picture>
      ) : null}
      {!available ? (
        <>
          <div
            role="img"
            aria-label={alt ? `${unavailable}: ${alt}` : unavailable}
            className="max-w-full rounded-xl bg-muted p-5 text-sm text-muted-foreground [overflow-wrap:anywhere]"
          >
            <span className="block font-medium">{unavailable}</span>
            {alt ? <span className="mt-1 block whitespace-pre-wrap [overflow-wrap:anywhere]">{alt}</span> : null}
          </div>
          {admitted && (phase === 'failed' || recovering) ? (
            <button
              type="button"
              onClick={retry}
              disabled={recovering}
              className="rounded-md px-3 py-2 text-sm underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
            >
              {m.document_image_retry({}, options)}
            </button>
          ) : null}
        </>
      ) : null}
      {available && image && inspectable ? (
        <DocumentImageInspector image={image} alt={alt} locale={locale} onUnavailable={() => setPhase('failed')} />
      ) : null}
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
