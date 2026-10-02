'use client';

import { MediaImageProvider, type MediaImageReference, type MediaImageViewer } from '@rezics/ui/media-image';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { imageReferenceFromUrl, resolveMediaMetadata } from '../api/media-metadata.ts';
import { mediaMessages } from './media-messages.ts';
import { WebRatedContentProvider } from './rated-content.tsx';

/** One viewer snapshot and one metadata batch per mounted set of image references. */
export function WebMediaProvider({ viewer: initial, actingSubject, locale, children }: {
  viewer: MediaImageViewer; actingSubject?: string | null; locale: UiLocale; children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState({ basis: initial, viewer: initial });
  const viewer = snapshot.basis === initial ? snapshot.viewer : initial;
  const [refreshSerial, setRefreshSerial] = useState(0);
  useEffect(() => {
    let active = true;
    let revision = 0;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      const requestRevision = ++revision;
      controller?.abort();
      controller = new AbortController();
      setSnapshot(prior => ({ basis: initial, viewer: { ...(prior.basis === initial ? prior.viewer : initial), ready: false } }));
      try {
        const response = await fetch('/api/media-viewer', { cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        const next = await response.json() as MediaImageViewer;
        if (active && revision === requestRevision && typeof next.ready === 'boolean' && next.optIns) {
          setSnapshot({ basis: initial, viewer: next });
          setRefreshSerial(value => value + 1);
        }
      } catch {
        if (active && revision === requestRevision) setSnapshot({ basis: initial, viewer: { ...initial, ready: false } });
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    if (!initial.ready) void refresh();
    return () => { active = false; controller?.abort(); window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh); };
  }, [initial, actingSubject]);
  const resolve = useCallback((references: MediaImageReference[]) => resolveMediaMetadata(references, actingSubject), [actingSubject]);
  const refreshKey = `${actingSubject ?? 'anonymous'}:${refreshSerial}`;
  return <MediaImageProvider refreshKey={refreshKey} referenceFromUrl={imageReferenceFromUrl}
    viewer={viewer} resolve={resolve} labels={mediaMessages[locale]}>
    <WebRatedContentProvider refreshKey={refreshKey} viewer={viewer} actingSubject={actingSubject} locale={locale}>
      {children}
    </WebRatedContentProvider>
  </MediaImageProvider>;
}
