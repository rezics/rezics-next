import { checkDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { DocumentBody } from '@rezics/ui/document-body';
import type { ZonePresentationRead } from '../realm/types.ts';

export type ZoneHomePage = Pick<NonNullable<ZonePresentationRead['home']>, 'document' | 'blocks'>;

/** The published home page, when the route carried a document this reader can show. */
export function zoneHomeDocument(page: unknown): DocumentSnapshot | null {
  if (!page || typeof page !== 'object' || !('document' in page)) return null;
  const document = (page as { document?: unknown }).document;
  return checkDocument(document) ? document : null;
}

/** The home page as it reads. Mounts stay in the site navigation, so they are not repeated here. */
export function ZoneHomeDocument({ document, blocks = [], className }: {
  document: DocumentSnapshot; blocks?: ZoneHomePage['blocks']; className?: string;
}) {
  return <DocumentBody document={zoneHomeProse(document, blocks)} className={className} />;
}

/** Main resolves Showcase blocks; their modules render in the home layout, once. Opaque blocks retain their fallback. */
export function zoneHomeProse(document: DocumentSnapshot, blocks: ZoneHomePage['blocks']): DocumentSnapshot {
  const resolved = new Set(blocks.filter(block => block.status === 'resolved').map(block => block.id));
  if (!resolved.size) return document;
  function prose(node: DocumentNode): DocumentNode[] {
    if (node.type === 'extensionBlock' && typeof node.attrs?.id === 'string' && resolved.has(node.attrs.id)) return [];
    return [{ ...node, ...(node.content ? { content: node.content.flatMap(prose) } : {}) }];
  }
  return { ...document, doc: prose(document.doc)[0]! };
}
