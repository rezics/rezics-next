import { useLayoutEffect, useId, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import {
  collectionPublicDocument,
  type CollectionPublicContext,
  type CollectionPublicPage,
} from './collection-public-document';

import type { CollectionPageResult } from './collection-load';
import {
  captureCollectionExport,
  CollectionExportAttempt,
  type CollectionExportCapture,
  type CollectionExportFile,
  type CollectionExportResult,
} from './collection-export-request';

type ExportRequest = (
  capture: CollectionExportCapture,
  context: CollectionPublicContext,
) => Promise<CollectionExportResult>;
const nativeExportRequest: ExportRequest = async (capture, context) => {
  const { readCollectionExport } = await import('./collection-export-read');
  return readCollectionExport({ data: { capture, context } });
};

export function downloadCollectionItemList(
  page: CollectionPublicPage,
  context: CollectionPublicContext,
  laterPage = false,
) {
  const file = collectionPublicDocument(page, context, laterPage);
  if (!file) return false;
  return downloadFile(file);
}

function downloadFile(file: CollectionExportFile) {
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

/** The public document controls require an admitted native request before browser delivery. */
export function CollectionExport({
  page,
  context,
  laterPage = false,
  request = nativeExportRequest,
}: {
  page: CollectionPublicPage;
  context: CollectionPublicContext;
  laterPage?: boolean;
  request?: ExportRequest;
}) {
  const { origin, locale } = context;
  const capture = captureCollectionExport(page as CollectionPageResult);
  const available = capture !== null && collectionPublicDocument(page, context, laterPage) !== null;
  const signature = capture ? JSON.stringify(capture) : null;
  const [lifetime, setLifetime] = useState({ page, origin, locale, laterPage, available, signature, key: 0 });
  if (
    lifetime.page !== page ||
    lifetime.origin !== origin ||
    lifetime.locale !== locale ||
    lifetime.laterPage !== laterPage ||
    lifetime.available !== available ||
    lifetime.signature !== signature
  ) {
    // Reset before committing the replacement view, including a return to an earlier payload.
    setLifetime({ page, origin, locale, laterPage, available, signature, key: lifetime.key + 1 });
  }

  if (!available || !capture) return null;
  return <CollectionExportActions key={lifetime.key} capture={capture} context={context} request={request} />;
}

/** A retired instance may finish clipboard IO, but its state cannot reach the replacement controls. */
function CollectionExportActions({
  capture,
  context,
  request,
}: {
  capture: CollectionExportCapture;
  context: CollectionPublicContext;
  request: ExportRequest;
}) {
  const descriptionId = useId();
  const attempt = useRef(new CollectionExportAttempt(capture));
  const inFlight = useRef<object | null>(null);
  const prepared = useRef<CollectionExportFile | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  useLayoutEffect(
    () => () => {
      attempt.current.cancel();
      inFlight.current = null;
      prepared.current = null;
    },
    [],
  );

  function cancel() {
    attempt.current.cancel();
    inFlight.current = null;
    prepared.current = null;
    setPending(false);
    setNotice('');
  }

  async function perform(kind: 'download' | 'copy') {
    if (inFlight.current) return;
    const operation = {};
    inFlight.current = operation;
    setPending(true);
    setNotice('');
    let message = m.library_collection_export_failed();
    let delivering = false;
    try {
      let file = prepared.current;
      if (!file) {
        const result = await attempt.current.run((captured) => request(captured, context));
        if (inFlight.current !== operation || result.state === 'cancelled') return;
        if (result.state !== 'complete') {
          message = m.library_collection_export_unavailable();
          return;
        }
        // Keep the admitted bytes and file metadata for deliberate local retries in this lifetime.
        file = { ...result.file };
        prepared.current = file;
      }
      delivering = true;
      if (kind === 'download') downloadFile(file);
      else await navigator.clipboard.writeText(file.text);
      message = kind === 'download' ? m.library_collection_export_downloaded() : m.library_collection_export_copied();
    } catch {
      message = delivering ? m.library_collection_export_delivery_failed() : m.library_collection_export_failed();
    } finally {
      if (inFlight.current === operation) {
        inFlight.current = null;
        setPending(false);
        setNotice(message);
      }
    }
  }

  return (
    <div role="group" aria-label={m.library_collection_export_label()} className="max-w-sm space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          aria-describedby={descriptionId}
          onClick={() => void perform('download')}
        >
          {m.library_collection_export_download()}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          aria-describedby={descriptionId}
          onClick={() => void perform('copy')}
        >
          {m.library_collection_export_copy()}
        </Button>
        {pending || prepared.current !== null ? (
          <Button type="button" variant="outline" onClick={cancel}>
            {m.library_collection_cancel()}
          </Button>
        ) : null}
      </div>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {m.library_collection_export_note()}
      </p>
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm">
        {notice}
      </p>
    </div>
  );
}
