/**
 * TEST ONLY. IMPORT_VNDB_TABLES_DRIVER exports createVndbTablesDriver(limits).
 * Bind actual importer begin/stage/page/commit operations and durable indexed
 * importer-owned storage. The adapter forwards raw archive-entry streams unchanged;
 * it must not parse COPY, group rows, implement conversion or model run state.
 * Tar/zstd acquisition is outside this boundary. No live VNDB API fallback.
 * close removes isolated fixtures; reopen closes/reopens real storage handles,
 * preserving only durable state (including committed source baselines).
 *
 * Evidence reused from the downloaded official 2026-10-25 dump and generator:
 * https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst (README.txt, schema_vndbid.sql)
 * https://g.blicky.net/vndb.git/tree/util/dbdump.pl (export_table)
 * SHA256 README: 49dc1574d7a656fa43fe0809f1981e09c401a0fa0c3c365d9fc0509c3c71e454
 * SHA256 schema: d608ec4022029bdb65a5c780bbf8ca46e3348f16eaa7b88290efde35e2dd4758
 * SHA256 generator: 7849210e7df27c12ba93bb98b9440cca3b28f2f0dfe6142bdfde54075d2d5608
 * The six fixture files are synthetic COPY TO STDOUT bytes and tab-separated
 * headers, with real columns. They are not SQL, JSON or pregrouped source records.
 * entry_meta's exported column is id, although the generator selects itemid.
 *
 * Grouped payload follows the independently frozen imports-vndb-driver.ts suite:
 * vn object, vn_titles array, entry_meta object with numeric per-entry revision.
 * entry_meta also contains other entry types: skip those, not orphan v IDs.
 * No auxiliary table is needed for the current metadata-only converter. Use the
 * actual VNDB @rezics/conversion module and its converter_revision by reference.
 * converter below has the frozen binding's structural observation interface;
 * observation paths point into actual semantic proposals, never a shadow model.
 * parseProposal uses the real semantic validator, not a test schema. Proposals
 * remain opaque: this file defines no competing public bulk API.
 *
 * All required tables validate before page/conversion/proposal publication.
 * commit promotes only a complete validated run to the comparison baseline;
 * failed runs cannot become disappearances or replace the previous baseline.
 * Skip unrelated tables without parsing or retaining personal data, including
 * spools/logs. Never execute any SQL shipped in the archive.
 *
 * Cost contract (no performance Goal harness exists in this checkout): N is
 * accumulated importer/catalogue keys; U*t is unrelated historical activity;
 * S is supplied supported table rows/bytes; M is supported child rows per VN.
 * Each supplied supported row is staged exactly once by keyed insert/update,
 * O(S log N). No existing partition/table/history enumeration. Materialization
 * uses exact (source, run, table, entry_id) indexed seeks, O((1+M) log N) and
 * O(M) memory. Pages use keyset ranges and a fixed cap, never OFFSET. Maintained
 * run/source counters replace COUNT. No cross-kernel-partition SQL.
 *
 * measure observes actual executor statement counts, examined rows, index/VM
 * steps, fullscan steps and buffered rows, including nested production calls.
 * It must not use EXPLAIN estimates, adapter constants, wall-clock time or reset
 * counters between nested operations. Backends must expose equivalent measured
 * index work if they lack VM counters. inspect uses maintained counters. Seed
 * writes real unrelated importer/catalogue keys and history outside measurement;
 * it does not materialize measured records. These exact bounds are asserted:
 * 32/128/512 unrelated keys, four history rows/key, fixed M=2: <=16 statements,
 * <=4*(1+M) examined rows, <=32*(1+M)*ceil(log2(N+2)) index steps,
 * <=128*(1+M)*ceil(log2(N+2)) VM steps, zero full/partition scans or OFFSET.
 * At 16x N, index/VM work <=3x the initial work plus the fixed allowances in
 * the suite. M=2/4/8 is accepted; M=9 aborts with the configured hard cap 8.
 * Stage row writes equal S; encoded durable bytes <=8*input bytes+4096 and
 * do not grow with preexisting N or history. Peak buffered rows <=16*(8+2).
 * Stage statements/examined rows <=8*S+16, index steps <=32*(S+1)*ceil(log2(N+2)),
 * VM steps <=128*(S+1)*ceil(log2(N+2)); every scan/offset counter stays zero.
 */
export type Path = readonly (string | number)[];
export interface Entry {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'hardlink';
  declaredBytes: number;
  bytes: AsyncIterable<Uint8Array>;
  linkTarget?: string;
}
export interface GroupedRecord {
  vn: Record<string, unknown> & { id: string };
  vn_titles: Array<{ id: string; lang: string; official: boolean; title: string; latin: string | null }>;
  entry_meta: { id: string; created: string; lastmod: string; revision: number; num_edits: number; num_users: number };
}
export interface Converter {
  readonly converter_revision: string;
  convert(record: unknown): unknown;
  locate(output: unknown): { proposals: Path[]; converterRevision: Path };
  parseProposal(proposal: unknown): unknown;
  observe(proposal: unknown): Array<{
    kind: string;
    value: unknown;
    valuePath: Path;
    language?: string;
    fieldGroupPath: Path;
    reference: { source: Path; externalId: Path; revision: Path; url: Path };
    rights: { databaseLicense: Path; contentsLicense: Path; attribution: Path };
  }>;
}
export interface Cost {
  statements: number;
  examinedRows: number;
  indexSteps: number;
  vmSteps: number;
  fullscanSteps: number;
  wholePartitionReads: number;
  offsetStatements: number;
  crossPartitionStatements: number;
  /** Actual staging row inserts/updates, including accidental copies; excludes run-counter metadata. */
  rowWrites: number;
  peakBufferedRows: number;
}
export interface Baseline {
  run: string;
  revision: number;
  digest: string;
  converterRevision: string;
}
export interface VndbTablesDriver {
  readonly converter: Converter;
  begin(): Promise<string>;
  stage(run: string, entries: AsyncIterable<Entry>): Promise<void>;
  page(
    run: string,
    after: string | null,
    limit: number,
  ): Promise<{
    records: Array<{ key: string; revision: number; record: GroupedRecord; output: unknown }>;
    next: string | null;
  }>;
  commit(run: string): Promise<void>;
  baseline(key: string): Promise<Baseline | null>;
  inspect(run: string): Promise<{
    state: 'new' | 'staging' | 'ready' | 'failed';
    sourceRecords: number;
    stagedRows: number;
    stagedBytes: number;
    retainedTables: string[];
    proposalEmissions: number;
    publishedProposals: number;
    externalRequests: string[];
    executedDumpStatements: number;
  }>;
  /** Search actual durable staging/spools/logs for these bytes, outside measurement. */
  retainedMarkers(markers: string[]): Promise<string[]>;
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; cost: Cost }>;
  /**
   * Seed unrelated VN rows/keys in earlier runs of the same VNDB importer tables
   * and storage partition, plus catalogue keys and unrelated historical activity.
   * Do not isolate them in another database/source/partition to evade the probe.
   */
  seed(input: { unrelatedKeys: number; historicalActivity: number }): Promise<void>;
  reopen(): Promise<void>;
  close(): Promise<void>;
}
export const limits = { childRowsPerVn: 8, pageSize: 16 } as const;
export async function loadVndbTablesDriver(): Promise<VndbTablesDriver> {
  const module = process.env.IMPORT_VNDB_TABLES_DRIVER;
  if (!module) throw new Error('IMPORT_VNDB_TABLES_DRIVER is required: bind real VNDB table ingestion');
  const binding = await import(module);
  return binding.createVndbTablesDriver(limits);
}
