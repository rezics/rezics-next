import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from '@rezics/ui/document-body';

/** The published home page, when the route carried a document this reader can show. */
export function zoneHomeDocument(page: unknown): DocumentSnapshot | null {
  if (!page || typeof page !== 'object' || !('document' in page)) return null;
  const document = (page as { document?: unknown }).document;
  return checkDocument(document) ? document : null;
}

/** The home page as it reads. Mounts stay in the site navigation, so they are not repeated here. */
export function ZoneHomeDocument({ document, className }: { document: DocumentSnapshot; className?: string }) {
  return <DocumentBody document={document} className={className} />;
}
