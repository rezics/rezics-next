import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Test-only observation binding, NOT a bulk/proposal API. Export
 * createWikidataDriver() from IMPORT_WIKIDATA_DRIVER (absolute path/file URL).
 * Bind the actual pure Wikidata source module in @rezics/conversion, using the
 * bundled definitions' mappings. JSON-lines parsing belongs elsewhere.
 * converter_revision must be the source module's explicit revision export.
 *
 * Source titles are schema:name propose statements with monolingualtext content,
 * separate from creation labels. Refresh can retract old source candidates while
 * leaving those initial labels set; pure conversion does not perform persistence.
 * convert calls that module synchronously with the supplied entity and immutable
 * external-entity resolution map. No fetching, persistence, generated relation
 * IDs, SQL, importer state, authorization or product behavior in this binding.
 * It may capture an actual converter validation exception as raw for observe.
 * observe only projects actual output/errors. Every pointer is an RFC 6901
 * pointer into raw; statement/term pointers point into their command payload.
 * References and field groups must already exist in those proposals; factual
 * commands have no rights. Licence pointers may locate actual source metadata
 * outside commands; this is CC0 source permission, not output database rights;
 * never synthesize these in observe. Enumerate ALL commands and statements.
 *
 * Forward the supplied native context unchanged. accept is a narrow fake bulk
 * consumer: call @rezics/definitions/bulk checkBatchWrite, the real command
 * structural validator, without executing any command. Return its accepted
 * command and the citations it retains, or throw on structural rejection.
 * No hand-built competing bulk schema or permissive echo consumer. The semantic
 * owner controls the production shape; these pointers accommodate that shape.
 */
export interface CitationPointers {
  reference: string;
  source: string;
  externalId: string;
  sourceRevision: string;
  license: string;
  url: string;
}
export interface ProposalPointers {
  command: string;
  fieldGroups: string[];
  citations: CitationPointers[];
  labels?: string;
  descriptions?: string;
  aliases?: string;
  subjectType?: string;
  statements: string[];
}
export interface WikidataObservation {
  outcome: 'converted' | 'ignored' | 'invalid';
  proposals: ProposalPointers[];
  /** Actual converter diagnostics, including validation errors captured above. */
  diagnostics: { pointer: string; code: string }[];
}
export interface WikidataDriver {
  readonly converter_revision: string;
  convert(
    entity: unknown,
    resolvedEntities: Readonly<Record<string, string>>,
    context?: { subjectId: string },
  ): unknown;
  observe(raw: unknown): WikidataObservation;
  accept(command: unknown): { command: import('@rezics/definitions/bulk').BatchCommand; citations: unknown[] };
}

export async function loadWikidataDriver(): Promise<WikidataDriver> {
  const location = process.env.IMPORT_WIKIDATA_DRIVER;
  if (!location) throw new Error('IMPORT_WIKIDATA_DRIVER is required: bind the production wikidata converter');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('IMPORT_WIKIDATA_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORT_WIKIDATA_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createWikidataDriver !== 'function') throw new Error('Expected createWikidataDriver factory');
  return binding.createWikidataDriver();
}
