/**
 * Test-only binding: IMPORT_OPEN_LIBRARY_DRIVER names an absolute path or file URL
 * exporting createOpenLibraryDriver(). Bind the actual @rezics/conversion source
 * module for Open Library, including its exported converter_revision. convert is
 * synchronous and pure; it receives the JSON payload, never a TSV row or filename.
 * No product behavior, generated facts, rights decisions or references in adapters.
 *
 * consume is a narrow typed fake bulk consumer: use semantic's actual command
 * proposal types AND structural validator, then collect accepted proposals without
 * executing them. Do not define another bulk API, accept arbitrary objects, write
 * SQL, call a live API, or replace source citations. Observations describe accepted
 * commands, never an adapter-maintained model. Paths are RFC 6901 pointers relative
 * to the cited accepted command; all values must resolve to its actual leaves.
 * kind and mode are test vocabulary mapped from real properties/rights definitions;
 * path identifies the underlying rights envelope, reference and field group.
 *
 * Fixture shapes and scope (synthetic records, not claims about real books):
 * https://openlibrary.org/developers/dumps
 * https://github.com/internetarchive/openlibrary-client/tree/master/olclient/schemata
 * Bibliographic permission, not an image license:
 * https://openlibrary.org/help/faq/using
 * https://openlibrary.org/dev/docs/api/covers
 * Import decision: discussion ADR-0036, Imports and Rights decisions.
 */
export type RecordPayload = Record<string, unknown>;
export type Conversion = {
  outcome: 'converted' | 'skipped' | 'rejected';
  converter_revision: string;
  proposals: unknown[];
  /** Nonempty source-specific diagnostic for skipped/rejected input. */
  reason?: string;
};
export interface FieldObservation {
  kind: 'identity' | 'title' | 'author' | 'work' | 'isbn10' | 'isbn13' | 'publishDate' | 'description' | 'cover';
  command: number;
  valuePath: string;
  groupPath: string;
  reference: {
    path: string;
    keyPath: string;
    urlPath: string;
    revisionPath: string;
    lastModifiedPath: string;
  };
  rights: {
    path: string;
    mode: 'fact' | 'verbatim';
    /** Null is an explicit unknown license, never inferred CC0 for images. */
    licensePath: string;
  };
}
export interface OpenLibraryDriver {
  readonly converter_revision: string;
  convert(record: RecordPayload): Conversion;
  /** Throw on structural rejection; accepted contains the actual parsed commands. */
  consume(proposals: readonly unknown[]): {
    accepted: unknown[];
    fields: FieldObservation[];
  };
}
export async function loadOpenLibraryDriver(): Promise<OpenLibraryDriver> {
  const path = process.env.IMPORT_OPEN_LIBRARY_DRIVER;
  if (!path) throw new Error('IMPORT_OPEN_LIBRARY_DRIVER is required: bind the production open-library converter');
  return (await import(path)).createOpenLibraryDriver();
}
