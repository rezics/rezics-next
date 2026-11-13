import type { PageDocument } from './render';
import { projectReadingDocument, readingOverviewDocument } from './reading-overview';

// Retain the installed Book consumer contract while all reading domains use the same presentation policy.
export {
  ReadingOverviewContext as BookOverviewContext,
  READING_REVIEW_PREVIEW_LIMIT as BOOK_REVIEW_PREVIEW_LIMIT,
  ReadingOverviewRoot as BookOverviewRoot,
  ReadingOverviewSections as BookOverviewSections,
} from './reading-overview';

export function isBookOverview(type: string | undefined, view: string, account: boolean, literary = false): boolean {
  return !account && (literary || type === 'schema:Book') && view === 'overview';
}
export const bookOverviewDocument = readingOverviewDocument;

/** The mounted reader owns these exact native nodes; unrelated composition stays in its original order. */
export function literaryDetailDocument(document: PageDocument, ownedNodes: ReadonlySet<string>): PageDocument {
  return projectReadingDocument(document, (node) => ownedNodes.has(node.props.id));
}
