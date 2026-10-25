/**
 * PRIVATE TEST CONTRACT, not a public instrumentation port or product proof.
 * IMPORT_COST_OBSERVER_DRIVER names a file URL/absolute module exporting
 * createImportCostObserverDriver(). No binding is supplied by this specification.
 *
 * Inspected: packages/conversion/src/{bangumi,vndb,wikidata,open-library}.ts
 * expose four independent synchronous pure converters over ConversionInput objects
 * (NOT encoded JSON). Their current source growth probes see only input reads;
 * Wikidata's returned metrics.inputBytes/fieldVisits omit downstream revisits.
 * Neither is a complete allocation/retention observer. Wrapping just the input,
 * JSON.stringify, or createHash cannot honestly implement this contract today.
 *
 * Proposed minimal PURE LOCAL mechanism, requiring manager approval/dispatch:
 * - bangumi.ts: own/string/normalize, tag loop, proposal construction/validation;
 * - vndb.ts: row/field/rows/text/project, title/link loops, proposals/validation;
 * - wikidata.ts: get/list/text/read, terms/snak/claims, mapping/proposals/validation;
 * - open-library.ts: own/array/string/normalize, ISBN/relation/cover loops,
 *   proposals/validation;
 * - support.ts: jsonSnapshot descriptor/stack/copy work, sourceDigest/commandKey
 *   canonicalization and hash, sourceEnvelope validation, safeSourceUrl,
 *   textDocument normalization/serialization;
 * - packages/document/src/index.ts: normalizeDocument, checkDocument, isJson,
 *   deepFreeze and serializeDocument; packages/definitions/src/bulk.ts validate/
 *   checkBatchWrite and media-import.ts structural/checkMediaImportRequest;
 *   canonicalize/lib/canonicalize.js traversal/sort and typebox/schema native
 *   validation boundaries must participate, not be counted free.
 *
 * No change to their behavior, schemas, caps, mappings or algorithm is authorized.
 * Each helper can return additive local diagnostics, composed locally by its
 * caller, with allocation identity/lifetime summaries. No callback mutating an
 * external meter, I/O, production global observer, alternate conversion or replay.
 * Errors need local partial diagnostics too; never leak input in numeric capture.
 * A private test build may extract these returned diagnostics and observe native
 * calls. It must retain the actual exports/results and default digests. There is
 * deliberately no pretend implementation or public diagnostic API here.
 *
 * Definition: fieldVisits counts actual data/descriptor/entry visits INCLUDING
 * repeated visits to normalized copies, validators, sorting comparisons and
 * canonicalization. byteVisits counts logical data bytes actually consumed or
 * written by each explicit byte/string pass (UTF-8 encoding/hash/JSON parse and
 * serialization included). workUnits = fieldVisits + byteVisits. This is semantic
 * work, NOT instruction counts, V8 heap, engine hidden allocations or VM/FFI cost.
 * Native algorithms' hidden steps cannot be observed: count actual boundary bytes
 * and local traversals, explicitly once per actual pass; never invent VM counters.
 * allocatedBytes counts each new logical backing allocation once. Buffer views
 * share their ArrayBuffer identity; count full backing byteLength, not view length.
 * Strings use UTF-8 data length per produced value, keys likewise; containers use
 * 8 logical bytes per occupied slot/entry plus key bytes. Numbers use 8, booleans
 * 1, null 0. These are portable data/metadata units, not physical heap sizes.
 * peakRetainedBytes counts simultaneously semantically live data backing stores,
 * deduplicated by identity, including borrowed input, output, parser stacks,
 * descriptors, sort scratch, canonical strings and hash/serialization buffers.
 * Replaced old and new backing stores overlap until their last actual use.
 * Strings have no JS backing identity: the local seam tracks produced-value tokens
 * and propagates them on aliasing; equality/interning must not deduplicate values.
 * Lexical last-use/release diagnostics are required: GC timing/heap sampling cannot
 * provide this metric. Track live backing identities only, discard released ones;
 * O(actual bounded work), bounded scratch, no persistent history/event log.
 *
 * measure has ONLY a callback, invokes it exactly once, captures all nested work
 * through settlement and failure, restores instrumentation in finally. Setup and
 * expected output are inaccessible. No fixture/source/M/N/history arguments,
 * expected-size arithmetic, static counts, timing, source SQL or credential reads.
 * Observe actual DB/partition/network/filesystem attempts, even if rejected/caught;
 * do not hard-code pure zeros. Never mock a converter, parser, validator or hash.
 *
 * Adapt workUnits/allocatedBytes/peakRetainedBytes directly into imports-growth
 * Counters, and workUnits into imports-api's converter CostPhase counters. Other
 * fields remain their actual probes; database partitions/network counts come from
 * attempts. Do not invent competing SQL or phase models. Dump-reader parsing is
 * separately O(supplied input), with the same byte-pass semantics; source callbacks
 * here receive native objects and must not be silently parsed/replayed by a driver.
 */
export const MISSING_COST_OBSERVER_DRIVER =
  'IMPORT_COST_OBSERVER_DRIVER is required: bind real pure-source cost observation';

export interface Cost {
  fieldVisits: number;
  byteVisits: number;
  workUnits: number;
  allocatedBytes: number;
  peakRetainedBytes: number;
  databaseAttempts: number;
  partitionAttempts: number;
  networkRequests: number;
  filesystemAttempts: number;
}
export type Observation<T> = { counters: Cost } & ({ ok: true; value: T } | { ok: false; error: unknown });
export interface ImportCostObserverDriver {
  measure<T>(callback: () => T | Promise<T>): Promise<Observation<T>>;
  /** Release private probes, never caller data; another instance remains independent. */
  close(): Promise<void>;
}
export type CreateImportCostObserverDriver = () => Promise<ImportCostObserverDriver>;
