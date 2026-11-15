import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentImageRenderer } from '@rezics/editor';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { useSession } from '../session';
import { cachedBrowserSession } from '../session/browser-state';
import { getLocale } from '../paraglide/runtime';
import { NativeDocumentImage, type DocumentImagePresentation } from '../threads/document-media';
import { readEditorImagePresentations } from './media-read';
import { readImagePresentationBatches } from './media-presentation-batches';

function imageIds(document: DocumentSnapshot): string[] {
  const ids = new Set<string>();
  const visit = (node: DocumentNode) => {
    if (
      node.type === 'image' &&
      typeof node.attrs?.src === 'string' &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(node.attrs.src)
    )
      ids.add(node.attrs.src);
    node.content?.forEach(visit);
  };
  visit(document.doc);
  return [...ids].sort();
}

/** One bounded read per changed image set/viewer; ordinary typing and occurrence styling do not refetch. */
export function useEditorImagePresentation(
  document: DocumentSnapshot,
  enabled = true,
): {
  renderImage: DocumentImageRenderer;
  visitKey: string;
} {
  const session = useSession();
  const client = useQueryClient();
  const identity = JSON.stringify([
    session.state,
    session.state === 'signed-in' ? session.subject : null,
    session.state === 'signed-in' ? session.csrfToken : null,
  ]);
  const ids = useMemo(() => (enabled ? imageIds(document) : []), [document, enabled]);
  const idsKey = JSON.stringify(ids);
  const key = `${identity}:${idsKey}`;
  const live = useRef(key);
  live.current = key;
  const [observed, setObserved] = useState<{
    key: string;
    settled: ReadonlySet<string>;
    images: ReadonlyMap<string, DocumentImagePresentation>;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    if (!ids.length) return () => controller.abort();
    const current = () => {
      const currentSession = cachedBrowserSession(client);
      const currentIdentity = JSON.stringify([
        currentSession.state,
        currentSession.state === 'signed-in' ? currentSession.subject : null,
        currentSession.state === 'signed-in' ? currentSession.csrfToken : null,
      ]);
      return !controller.signal.aborted && live.current === key && currentIdentity === identity;
    };
    void readImagePresentationBatches(
      ids,
      (batch) =>
        readEditorImagePresentations({
          data: { ids: batch, subject: session.state === 'signed-in' ? (session.subject ?? null) : null },
          signal: controller.signal,
        }),
      (completed, received) =>
        setObserved((previous) => {
          if (!current()) return previous;
          const images = new Map(previous?.key === key ? previous.images : []);
          const settled = new Set(previous?.key === key ? previous.settled : []);
          for (const id of completed) settled.add(id);
          for (const image of received) images.set(image.id, image);
          return { key, settled, images };
        }),
      current,
    );
    return () => controller.abort();
  }, [client, identity, idsKey]);
  const locale = getLocale();
  const renderImage: DocumentImageRenderer = useCallback(
    (occurrence) => {
      // Null means unresolved: the editor may still show its own accepted, visit-owned local file preview.
      if (observed?.key !== key || !observed.settled.has(occurrence.src)) return null;
      const image = observed.images.get(occurrence.src);
      if (!image) return null;
      return (
        <NativeDocumentImage
          image={image}
          mediaId={occurrence.src}
          occurrence={occurrence}
          alt={occurrence.alt}
          locale={locale}
          inspectable={false}
        />
      );
    },
    [key, locale, observed],
  );
  return { renderImage, visitKey: identity };
}
