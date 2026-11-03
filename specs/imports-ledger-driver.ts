import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';

/**
 * TEST ONLY. IMPORT_LEDGER_DRIVER exports createImportLedgerDriver(options).
 * Bind real importer reconciliation, durable importer-owned SQLite/tables and
 * the pure @rezics/conversion Wikidata source module, with explicit revision.
 * No kernel DB is available or writable. Never model reconciliation here.
 * Each source is an independent configured feed using that same source module.
 * close releases handles; reopening the same directory reads actual disk state.
 * The factory cleans partial setup on failure. The suite removes its directory.
 *
 * This is a state outcome suite with a fixture fake bulk client, NOT production
 * API/authorization coverage. Server fence enforcement belongs to that suite.
 * All writes are real command proposals through the injected bulk transport;
 * no direct subject SQL, invented proposals, policy evaluation or cached results.
 * The types below are test observations, not a competing semantic bulk API.
 * The harness maps failure dispositions to portable per-command results. The
 * binding forwards those results unchanged; it must never invent result IDs.
 */
export interface FenceKey {
  source: string;
  external_id: string;
  field_group: string;
}
export interface CommandObservation extends FenceKey {
  /** Exact serialized semantic command, not a reconstruction from fixture input. */
  command: BatchCommand;
  kind: 'create' | 'propose' | 'retract';
  idempotencyKey: string;
  /** Read only from actual serialized values/references; facts have no rights. */
  values: string[];
  references: string[];
  licenses: string[];
}
export interface FixtureBulkClient {
  /** Receives the real serialized semantic bulk request, never observations. */
  send(request: BatchWriteRequest): Promise<BatchWriteResult>;
}
export interface LedgerRow {
  source: string;
  recordKey: string;
  recordRevision: string;
  digest: string;
  converter_revision: string;
  state: 'present' | 'vanished';
}
export interface Snapshot {
  /** Last COMPLETE successful source snapshot; failed/partial runs retain it. */
  committedSnapshot: string | null;
  /** Actual durable acknowledged rows, sorted by recordKey, including vanished. */
  rows: LedgerRow[];
}
export interface RunInput {
  source: string;
  dump: string | AsyncIterable<string>;
  /** Production converter registration metadata; never adapter conversion logic. */
  converter_revision: string;
  /** Fraction in [0,1]; omitted means strictly more than 0.20. */
  disappearanceThreshold?: number;
}
export interface RunResult {
  status: 'committed' | 'invalid-dump' | 'mass-disappearance' | 'bulk-failed' | 'interrupted' | 'busy' | 'observation-conflict';
  new: string[];
  changed: string[];
  unchanged: string[];
  vanished: string[];
  /** Safe diagnostics from the actual run, without source body/private text. */
  diagnostic: string;
}
export interface ImportLedgerDriver {
  close(): Promise<void>;
  run(input: RunInput): Promise<RunResult>;
  observe(source: string): Promise<Snapshot>;
  /**
   * Validate with the REAL semantic bulk consumer's structural parser/schema;
   * throw on invalid/empty requests. Normalize only fields from parsed commands.
   * Enumerate every command in order. Each observation points at its command and
   * field group. No invented provenance, deletion intent or acknowledgement.
   */
  inspectBulk(request: unknown): CommandObservation[];
  /**
   * Actual production conversion outputs captured during run, never reconstructed
   * policy. Pointer is RFC 6901 into raw and locates source licence metadata or
   * a real citation. CC0 source permission is distinct from ODbL database rights.
   * Missing native revisions stay unversioned; both configured revision strings
   * used by this suite must be explicitly trusted registrations of Wikidata.
   */
  conversionOutputs(): { raw: unknown; sourceLicensePointer: string }[];
  /** Real fault boundary after API success, before local acknowledgement commit. */
  interruptNextAfterBulkSuccess(): void;
}
export interface DriverOptions {
  directory: string;
  bulk: FixtureBulkClient;
  /** Actual importer fence lookup dependency, invoked even on unchanged refresh. */
  readFence(key: FenceKey): Promise<{ fenced: boolean; securityRevision: string | null }>;
}
export type CreateImportLedgerDriver = (options: DriverOptions) => Promise<ImportLedgerDriver>;
