/**
 * TEST ONLY. IMPORT_RUN_PLANS_DRIVER exports createImportRunPlansDriver.
 * Forward actual durable RunStore prepare/classify/pagePending/acknowledge/
 * finalize/reopen operations. No in-memory plans, synthesized responses, parsing,
 * converter, transport, kernel writes or subject/native-id allocation here.
 * Existing RunStore contracts, leases, mass-disappearance and fence rules apply.
 * Existing classify, unscoped acknowledge and one-envelope caps remain unchanged;
 * scoped acknowledge forwards the actual record ownership guard. prepare is the
 * private bounded record-plan entry point, not a competing public bulk schema.
 *
 * prepare atomically validates <=300 commands and <=2MiB JSON UTF-8 input bytes,
 * checks source/record/group ownership and duplicate keys over the ENTIRE plan,
 * and journals all commands, ordered keys and exact envelope bytes before any
 * dispatch. Each actual BatchWriteRequest uses the real portable validators,
 * <=100 commands and <=65536 UTF-8 bytes INCLUDING its envelope. An oversized
 * single command rejects explicitly, before persisting any part or dispatch.
 * No plan-prefix acceptance. No recomputation or reserialization under a key.
 *
 * Pending limit counts envelopes, not records. after is an opaque LOCAL cursor
 * for indexed (source, run, pending, record, envelope-index) keyset traversal;
 * callers must never compare/decode it or forward it to the portable API.
 * Reopen replays original envelopes byte-for-byte, including resolved commands
 * within a partly pending envelope. Only fully resolved envelopes disappear.
 * Acknowledgements are actual public-shaped per-envelope results. Missing or
 * rejected commands remain pending; duplicate successful results are idempotent.
 * Unknown/cross-source/run/record result keys reject atomically against the
 * supplied record scope. Legacy unscoped acknowledgement keeps its contract. Record acknowledged metadata advances only after every expected
 * command/group resolves. Full baseline advances only after the entire run.
 * Zero-command plans require unchanged proof or explicit fenced-safe omissions;
 * an unfenced failure can never be discharged by another group's fence.
 *
 * Cost: prepare O(M log N) writes/O(M) memory; pending O(log N + page envelopes),
 * acknowledgement exact command-key seeks O(M log N), maintained remaining count,
 * finalize one bounded restartable page. No OFFSET, COUNT, history scans, full
 * growing table/index scan, temp B-tree or automatic indexes. Streaming source
 * setup is separate from these measurements. Zero network/kernel partitions.
 *
 * measure MUST wrap actual SQLite with createSqliteProbe from
 * services/importer/tests/support/sqlite-growth.ts, installed before statements
 * are prepared, including every connection and rejection. Supplement its raw
 * evidence with actual sqlite_schema/PRAGMA introspection and ANALYZE/EQP for
 * every distinct SQL/binding at every scale, as required by runStoreCounts. Never
 * substitute callbacks, static indexed flags, wall time or invented counters.
 * Summaries count SQLite statements and returned rows; buffer IO is not observed.
 */
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import type { Evidence, Omission, Run, RunStoreDriver } from './imports-run-store-driver.ts';

export const MISSING_RUN_PLANS_DRIVER =
  'IMPORT_RUN_PLANS_DRIVER is required: bind real durable importer multi-envelope run plans';
export const PLAN_CAPS = {
  commands: 300,
  bytes: 2 * 1024 * 1024,
  envelopeCommands: 100,
  envelopeBytes: 65536,
} as const;
export interface RunPlansDriver extends RunStoreDriver {
  prepare(
    run: Run,
    recordKey: string,
    input: { commands: BatchCommand[]; omissions?: Omission[] },
  ): Promise<'new' | 'changed' | 'unchanged' | 'vanished'>;
  acknowledge(run: Run, result: BatchWriteResult, scope?: { recordKey: string }): Promise<void>;
  measure<T>(operation: () => Promise<T>): Promise<{
    value: T;
    evidence: Evidence;
    networkRequests: number;
    kernelPartitions: string[];
  }>;
}
export type CreateImportRunPlansDriver = (options: { directory: string }) => Promise<RunPlansDriver>;
