/**
 * Test-only binding: IMPORT_OPEN_LIBRARY_DRIVER names an absolute path or file URL
 * exporting createOpenLibraryDriver(). Bind the actual @rezics/conversion source
 * module for Open Library, including its exported converter_revision. convert is
 * synchronous and pure; it receives the JSON payload, never a TSV row or filename.
 * No product behavior, generated facts, rights decisions or references in adapters.
 *
 * Source titles are schema:name propose statements with monolingualtext content,
 * separate from creation labels. Refresh can retract old source candidates while
 * leaving those initial labels set; pure conversion does not perform persistence.
 * consume is a narrow typed fake bulk consumer: use the actual BatchCommand
 * type AND @rezics/definitions/bulk checkBatchWrite, then collect proposals without
 * executing them. Do not define another bulk API, accept arbitrary objects, write
 * SQL, call a live API, or replace source citations. Observations describe accepted
 * commands, never an adapter-maintained model. Paths are RFC 6901 pointers relative
 * to the cited accepted command; all values must resolve to its actual leaves.
 * kind is test vocabulary mapped from actual catalogue properties;
 * path identifies the underlying reference and field group. Facts have no rights.
 * Enumerate ALL actual commands/fields, including unsupported emissions. Metadata
 * pointers resolve into unchanged production output, including unknown-licensed
 * descriptions and importFromUrl intents; neither is a second bulk command shape.
 * Unknown prose is inspection metadata, never a document or publication permission.
 * Cover credit points to the real structured @rezics/definitions/media-import
 * credit (rightsHolder, via{name,url}, license, obligations), never a synthesized
 * display line. Its license pointer must locate credit.license. Description
 * license metadata may be null or LicenseRef-unknown; neither permits a summary.
 * Forward context unchanged to production. No resolving IDs, creating media,
 * constructing documents or licensing decisions in the binding.
 *
 * Fixture shapes and scope (synthetic records, not claims about real books):
 * https://openlibrary.org/developers/dumps
 * https://github.com/internetarchive/openlibrary-client/tree/master/olclient/schemata
 * Bibliographic permission, not an image license:
 * https://openlibrary.org/help/faq/using
 * https://openlibrary.org/dev/docs/api/covers
 * Import decision: discussion ADR-0036, Imports and Rights decisions.
 */
export type CommandProposal = import('@rezics/definitions/bulk').BatchCommand;
export interface ConversionContext {
  subjectId: string;
  resolvedReferences?: Readonly<Record<string, string>>;
  mediaIds?: Readonly<Record<string, string>>;
}
export type RecordPayload = Record<string, unknown>;
export type Conversion = {
  outcome: 'converted' | 'skipped' | 'rejected';
  converter_revision: string;
  proposals: CommandProposal[];
  /** Nonempty source-specific diagnostic for skipped/rejected input. */
  reason?: string;
};
export interface FieldObservation {
  /** isbn10 is rejection vocabulary only: valid ISBN-10 emits isbn13 under schema:isbn. */
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
  /** Statement path for relations; original relation keys and URLs remain in actual source citations. */
  statementPath?: string;
  /** Actual relation identifier leaf: canonical wdt:P648 content (OL...A/W/M), never a synthesized path. */
  sourceValuePath?: string;
}
export interface OpenLibraryDriver {
  readonly converter_revision: string;
  convert(record: RecordPayload, context?: ConversionContext): Conversion;
  /** Pointers into actual non-command converter metadata, never adapter decisions. */
  inspectMetadata(output: Conversion): {
    bibliographyPermission: string;
    assets: {
      kind: 'description' | 'cover';
      value: string;
      license: string;
      group: string;
      /** Pointer to the unchanged structured CoverCredit, not a display string. */
      credit?: string;
      provenance?: string;
      role?: string;
      takedownEligible?: string;
    }[];
  };
  /** Throw on structural rejection; accepted contains the actual parsed commands. */
  consume(proposals: readonly unknown[]): {
    accepted: CommandProposal[];
    fields: FieldObservation[];
  };
}
export async function loadOpenLibraryDriver(): Promise<OpenLibraryDriver> {
  const path = process.env.IMPORT_OPEN_LIBRARY_DRIVER;
  if (!path) throw new Error('IMPORT_OPEN_LIBRARY_DRIVER is required: bind the production open-library converter');
  return (await import(path)).createOpenLibraryDriver();
}
