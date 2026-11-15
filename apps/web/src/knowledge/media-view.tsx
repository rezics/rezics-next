import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { MediaImage } from '@rezics/ui/media-image';
import { Button } from '@rezics/ui/shadcn/button';
import type { DocumentSnapshot } from '@rezics/document';
import type { KnowledgeMediaSelection } from '@rezics/definitions/knowledge-media';
import { m } from '../paraglide/messages.js';
import { readerSessionSource } from '../reader/lifetime';
import type { DocumentImagePresentation } from '../threads/document-media';
import { knowledgeImageHref, knowledgeImageSources } from './media';
import { readKnowledgeMediaRequest, type KnowledgeMediaResult } from './media-read';

const empty = new Map<string, DocumentImagePresentation>();

/** One source-context grouped observation; text edits with unchanged image/source keys add no media read. */
export function useKnowledgeImagePresentations(
  body: DocumentSnapshot,
  own: KnowledgeMediaSelection | null,
  locale: string,
) {
  const client = useContext(QueryClientContext),
    sessionSource = readerSessionSource(client);
  const revision = useSyncExternalStore(sessionSource.subscribe, sessionSource.snapshot, sessionSource.serverSnapshot);
  const index = useMemo(() => knowledgeImageSources(body), [body]);
  const sourcesKey = JSON.stringify([...index.sources].sort()),
    selectionKey = JSON.stringify(own);
  const session = sessionSource.read();
  const viewer = session?.state === 'signed-in' ? (session.subject ?? null) : null;
  const owner = useMemo(() => ({}), [client, sourcesKey, selectionKey, viewer, revision, locale]);
  const [result, setResult] = useState<{
    owner: object;
    images: ReadonlyMap<string, DocumentImagePresentation>;
  } | null>(null);
  useEffect(() => {
    if (!client || index.overflow || !index.sources.length) return;
    let live = true;
    const request = new AbortController();
    void readKnowledgeMediaRequest({
      data: { sources: index.sources, own: own?.representation === 'authoring' ? own : null, viewer, locale },
      signal: request.signal,
    })
      .then((next: KnowledgeMediaResult) => {
        if (!live || request.signal.aborted || sessionSource.snapshot() !== revision) return;
        const images = new Map<string, DocumentImagePresentation>();
        if (next.state === 'ready')
          for (const image of next.images)
            if (index.sources.includes(image.source)) images.set(image.source, image.presentation);
        setResult({ owner, images });
      })
      .catch(() => {
        if (live && !request.signal.aborted) setResult({ owner, images: empty });
      });
    return () => {
      live = false;
      request.abort();
    };
  }, [owner]);
  return result?.owner === owner ? result.images : empty;
}

function KnowledgeImage({
  source,
  image,
  own,
  alt,
  locale,
  ownedOriginal,
}: {
  ownedOriginal?: { src: string; width?: number; height?: number } | null;
  source: string;
  image: DocumentImagePresentation | null;
  own: KnowledgeMediaSelection | null;
  alt: string;
  locale: string;
}) {
  const [phase, setPhase] = useState<'initial' | 'loaded' | 'failed'>('initial'),
    [attempt, setAttempt] = useState(0);
  const options = { locale: locale as never },
    unavailable = m.content_edition_image_unavailable({}, options);
  const variants =
    image?.variants.filter((variant) => knowledgeImageHref(source, `${variant.format}-${variant.width}`, own)) ?? [];
  const available = !!image && variants.length > 0 && phase !== 'failed';
  const credit = phase === 'loaded' ? image?.credit : null;
  return (
    <figure data-slot="knowledge-image" className="my-5 min-w-0 max-w-full space-y-2">
      {available ? (
        <MediaImage
          key={attempt}
          media={image.id}
          width={image.width}
          height={image.height}
          variants={variants}
          placeholder={image.placeholder}
          alt={alt}
          sizes="(min-width: 48rem) 65ch, calc(100vw - 3rem)"
          src={({ format, width }) => knowledgeImageHref(source, `${format}-${width}`, own)!}
          onImageLoad={() => setPhase('loaded')}
          onImageError={() => setPhase('failed')}
        />
      ) : ownedOriginal && phase !== 'failed' ? (
        <img
          src={ownedOriginal.src}
          width={ownedOriginal.width}
          height={ownedOriginal.height}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="block h-auto max-w-full rounded-xl"
          onError={() => setPhase('failed')}
        />
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
      {phase === 'failed' && (image || ownedOriginal) ? (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-7 max-w-full whitespace-normal"
          onClick={() => {
            setAttempt((value) => value + 1);
            setPhase('initial');
          }}
        >
          {m.correction_retry({}, options)}
        </Button>
      ) : null}
      {credit ? (
        <figcaption className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {credit.rightsHolder} · {m.document_image_via({}, options)}{' '}
          <a href={credit.via.url} rel="noopener noreferrer nofollow ugc" className="underline underline-offset-2">
            {credit.via.name}
          </a>
          {' · '}
          {credit.license}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** The callback consumes src as an opaque URI. It never changes the document, export bytes or ownership claims. */
export function useKnowledgeImageRenderer(
  body: DocumentSnapshot,
  own: KnowledgeMediaSelection | null,
  locale: string,
  ownedOriginal?: (source: string) => { src: string; width?: number; height?: number } | null,
) {
  const images = useKnowledgeImagePresentations(body, own, locale),
    selectionKey = JSON.stringify(own);
  return useCallback(
    ({ mediaId, alt }: { mediaId: string; alt: string }) => {
      const image = images.get(mediaId) ?? null;
      return (
        <KnowledgeImage
          key={JSON.stringify([mediaId, image, selectionKey])}
          source={mediaId}
          image={image}
          own={own}
          alt={alt}
          locale={locale}
          ownedOriginal={!image ? ownedOriginal?.(mediaId) : null}
        />
      );
    },
    [images, selectionKey, locale, ownedOriginal],
  );
}
