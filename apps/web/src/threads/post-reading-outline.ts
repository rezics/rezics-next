import type { DocumentSnapshot } from '@rezics/document';
import {
  projectPostReading,
  readingOutlineLabelLimit,
  readingOutlineLimit,
  type ReadingOutline,
  type ReadingOutlineEntry,
} from './post-reference-list';

export { readingOutlineLabelLimit, readingOutlineLimit };
export type { ReadingOutline, ReadingOutlineEntry };

/** Compatibility projection for callers interested only in section navigation. */
export function projectReadingOutline(
  document: DocumentSnapshot,
  revealed: ReadonlySet<number> = new Set(),
): ReadingOutline {
  return projectPostReading(document, revealed).outline;
}
