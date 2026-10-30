import { useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import {
  collectionPublicDocument,
  type CollectionPublicContext,
  type CollectionPublicPage,
} from './collection-public-document';

export function downloadCollectionItemList(
  page: CollectionPublicPage,
  context: CollectionPublicContext,
  laterPage = false,
) {
  const file = collectionPublicDocument(page, context, laterPage);
  if (!file) return false;
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(new Blob([file.text], { type: file.mediaType }));
  try {
    anchor.href = url;
    anchor.download = file.filename;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Let the browser consume the download before releasing this short-lived, local URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
}

export async function copyCollectionItemList(
  page: CollectionPublicPage,
  context: CollectionPublicContext,
  laterPage = false,
) {
  const file = collectionPublicDocument(page, context, laterPage);
  if (!file) return false;
  await navigator.clipboard.writeText(file.text);
  return true;
}

/** A read action over the current payload, with no source read, permission grant or export service. */
export function CollectionExport({
  page,
  context,
  laterPage = false,
}: {
  page: CollectionPublicPage;
  context: CollectionPublicContext;
  laterPage?: boolean;
}) {
  const descriptionId = useId();
  const available = collectionPublicDocument(page, context, laterPage) !== null;
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{
    page: CollectionPublicPage;
    origin: string;
    locale: string;
    message: string;
  } | null>(null);

  async function perform(kind: 'download' | 'copy') {
    if (!available || pending) return;
    setPending(true);
    setNotice(null);
    let message: string;
    try {
      const done =
        kind === 'download'
          ? downloadCollectionItemList(page, context, laterPage)
          : await copyCollectionItemList(page, context, laterPage);
      message = done
        ? kind === 'download'
          ? m.library_collection_export_downloaded()
          : m.library_collection_export_copied()
        : m.library_collection_export_unavailable();
    } catch {
      message = m.library_collection_export_failed();
    } finally {
      setPending(false);
    }
    setNotice({ page, origin: context.origin, locale: context.locale, message });
  }

  return (
    <div role="group" aria-label={m.library_collection_export_label()} className="max-w-sm space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!available || pending}
          aria-describedby={descriptionId}
          onClick={() => void perform('download')}
        >
          {m.library_collection_export_download()}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!available || pending}
          aria-describedby={descriptionId}
          onClick={() => void perform('copy')}
        >
          {m.library_collection_export_copy()}
        </Button>
      </div>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {available ? m.library_collection_export_note() : m.library_collection_export_unavailable()}
      </p>
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm">
        {available && notice?.page === page && notice.origin === context.origin && notice.locale === context.locale
          ? notice.message
          : ''}
      </p>
    </div>
  );
}
