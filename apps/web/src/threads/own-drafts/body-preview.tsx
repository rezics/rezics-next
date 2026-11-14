import type { DocumentSnapshot } from '@rezics/document';
import { m } from '../../paraglide/messages.js';
import { PostReadingBody } from '../post-reading-body';
import type { OwnDraftLocale } from './model';

/** Private, supplied bytes only: this caller has no media, mention or Subject resolver. */
export function OwnDraftBodyPreview({
  document,
  fallbackText,
  source,
  visitKey,
  documentLanguage,
  locale,
  current,
}: {
  document: DocumentSnapshot | null | undefined;
  fallbackText?: string;
  source: 'server' | 'browser' | 'readback';
  visitKey: string;
  documentLanguage: string | null;
  locale: OwnDraftLocale;
  current: () => boolean;
}) {
  const sourceVisit = JSON.stringify([source, visitKey]);
  if (!document) {
    return source === 'browser' ? (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{m.own_drafts_browser_text_fallback({}, { locale })}</p>
        <p lang={documentLanguage ?? ''} dir="auto" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {fallbackText}
        </p>
      </div>
    ) : null;
  }
  return (
    <PostReadingBody
      key={sourceVisit}
      document={document}
      documentLanguage={documentLanguage}
      locale={locale}
      readerIdentity={sourceVisit}
      visitKey={sourceVisit}
      wideVisitKey={sourceVisit}
      isReaderCurrent={current}
    />
  );
}
