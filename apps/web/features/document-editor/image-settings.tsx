'use client';

import { ImageSettings } from '@rezics/ui/image-settings';
import type { MediaImageMetadata } from '@rezics/ui/media-image';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { imageReferenceFromUrl, resolveMediaMetadata } from '../api/media-metadata.ts';
import { storedImageLabelEditor } from './local-image.ts';
import { mediaMessages } from './media-messages.ts';

/** Editing reads use the actual authoring identity, which may differ from the reading session's Agent. */
export function WebImageSettings({ src, actingSubject, locale, send = fetch }: {
  src: string; actingSubject: string; locale: UiLocale; send?: typeof fetch;
}) {
  const edit = useMemo(() => storedImageLabelEditor(actingSubject, send), [actingSubject, send]);
  const scope = useMemo(() => ({ src, actingSubject, send }), [src, actingSubject, send]);
  const [resolved, setResolved] = useState<{ scope: typeof scope; metadata: MediaImageMetadata | null | undefined }>();
  const metadata = resolved?.scope === scope ? resolved.metadata : undefined;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    let active = true;
    setResolved({ scope, metadata: undefined });
    const reference = imageReferenceFromUrl(src);
    if (reference) void resolveMediaMetadata([reference], actingSubject, send)
      .then(items => { if (active) setResolved({ scope, metadata: items[0] ?? null }); })
      .catch(() => { if (active) setResolved({ scope, metadata: null }); });
    else setResolved({ scope, metadata: null });
    return () => { active = false; };
  }, [scope, src, actingSubject, send]);
  if (metadata === undefined) return <p role="status" className="text-muted-foreground text-sm">{mediaMessages[locale].loading}</p>;
  if (!metadata) return <p role="status" className="text-muted-foreground text-sm">{mediaMessages[locale].unavailable}</p>;
  return <ImageSettings metadata={metadata} onEditImageLabels={edit} onMetadataChange={next => {
    if (currentScope.current === scope) setResolved({ scope, metadata: next });
  }} />;
}
