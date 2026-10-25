/**
 * Test-only binding: IMPORT_OPEN_LIBRARY_DRIVER names an absolute path or file URL
 * exporting createOpenLibraryDriver(). Bind the actual @rezics/conversion source
 * module for Open Library, including its exported converter_revision. convert is
 * synchronous and pure; it receives the JSON payload, never a TSV row or filename.
 * No product behavior, generated facts, rights decisions or references in adapters.
 *
 * Without subjectId, conversion emits exactly one create containing only type,
 * labels and optional descriptions/aliases, plus its normal key and full Source
 * envelope (facts). No subject.statements, generated subject IDs or summary/cover
 * creates. Creation metadata is immutable; it has no BatchReference field.
 * Every source statement, including identity and titles, is a later propose to
 * the supplied actual subjectId, with its full citations and applicable rights.
 * Candidate IDs come from actual proposal results for refresh/retraction; this
 * pure binding neither fabricates them nor extends bulk results. Enumerate the
 * whole actual output; never filter commands or synthesize bootstrap references.
 *
 * Source titles are schema:name propose statements with monolingualtext content,
 * separate from creation labels. Refresh can retract old source candidates while
 * leaving those initial labels set; pure conversion does not perform persistence.
 * consume is a narrow typed fake bulk consumer: use the actual BatchCommand
 * type AND @rezics/definitions/bulk checkBatchWrite, plus the real checkTyped
 * against the actual definitions release in product bindings. Collect proposals
 * without executing them. Do not define another bulk API, accept arbitrary objects, write
 * SQL, call a live API, or replace source citations. Observations describe accepted
 * commands, never an adapter-maintained model. Paths are RFC 6901 pointers relative
 * to the cited accepted command; all values must resolve to its actual leaves.
 * Each statement cites the imported RECORD in one actual reference with four
 * parts: schema:url (original record URL), wdt:P648 (canonical OL...W/M ID),
 * schema:version (String(native revision)), and schema:dateModified (actual time
 * content: +YYYY-MM-DDT00:00:00Z, precision 11, Gregorian calendarmodel). Native
 * last_modified is UTC; day precision is the finest released time precision.
 * Never emit schema:identifier, or version/dateModified as subject statements.
 * Those terms are reference-only and attached to no type by the catalogue owner;
 * schema:dateModified is mapped to wd:P5017.
 * The source envelope retains the full /works/ or /books/ external_id and string
 * record_revision. A sanitized digest projection may retain the raw timestamp;
 * it is not an invented public property. Reject malformed ISO timestamps before
 * emitting output. Relationship qualifiers retain canonical OL...A/W IDs, while
 * their citation identifies the imported record, not the related author/work.
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
    /** Actual wdt:P648 value.content leaf: canonical record OL...W/M ID. */
    keyPath: string;
    /** Actual schema:url value.content leaf: original record URL with full key. */
    urlPath: string;
    /** Actual schema:version value.content leaf: string native revision. */
    revisionPath: string;
    /** Actual schema:dateModified value.content object: exact source UTC day, precision 11. */
    lastModifiedPath: string;
  };
  /** Statement path for relations; their actual citations identify the imported record. */
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
      /** Pointer to the actual deferred cover asset or complete MediaImportRequest, never synthesized. */
      mediaImportRequest?: string;
      provenance?: string;
      role?: string;
      takedownEligible?: string;
    }[];
  };
  /** Throw on structural rejection; accepted contains the actual parsed commands. */
  consume(proposals: readonly unknown[]): {
    accepted: CommandProposal[];
    /** No statement fields for a metadata-only create; enumerate all resolved fields. */
    fields: FieldObservation[];
  };
}
export async function loadOpenLibraryDriver(): Promise<OpenLibraryDriver> {
  const path = process.env.IMPORT_OPEN_LIBRARY_DRIVER;
  if (!path) throw new Error('IMPORT_OPEN_LIBRARY_DRIVER is required: bind the production open-library converter');
  return (await import(path)).createOpenLibraryDriver();
}
