import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ImportSourceStatistic } from '../services/importer/src/import-contract.ts';
import type { ImportCredential, ImportIdentity } from '../services/kernel/test/imports/identity-fixture.ts';

/**
 * Test-only native binding. Run supplied decompressed ustar bytes through readArchive,
 * VndbTablesStore, createSourceRegistration, Importer and createImportTransport into
 * createKernel.handle. Use real Auth account-key issuance and real Access. Extend
 * the client's registered scopes and provision the statistic grant through actual
 * Auth/Access commands, never SQL setup of grants/bootstrap/content, permission
 * stubs, signed fixture access tokens, fake successful replies or direct rating writes.
 * Synthetic source bytes are the only source substitute. Observations below are
 * captured native requests, public responses and storage reads, never predictions.
 * close cleans partial opens; reopen retains importer SQLite and kernel data.
 */
export interface Exchange {
  method: string;
  path: string;
  authorization: string | null;
  idempotencyKey: string | null;
  /** Exact dispatched bytes, not JSON reserialization. */
  body: string | null;
  status: number;
  response: unknown;
  /** Actual persisted composite core.receipt identity; null on denial. */
  receipt: string | null;
  /** True only for the injected loss AFTER the real handler committed. */
  responseLost: boolean;
}
export interface Observation {
  /** Subject resolved by actual successful public batchWrite response, not SQL setup. */
  subjectId: string | null;
  /** Exact GET /v1/subjects/{id}/source-statistics response. */
  current: { status: number; body: unknown } | null;
  /** Captured public anonymous GET; null only before subject resolution. */
  currentRequest: { method: string; path: string; authorization: string | null } | null;
  /** Independently read native effects, scoped to this fixture's imported subjects. */
  storage: {
    statistics: ImportSourceStatistic[];
    /** Current rating.source_statistic.transaction_id values. */
    statisticTransactions: string[];
    /** All source-statistic changed outbox event IDs, including previous updates. */
    statisticEvents: string[];
    /** All rating.source_statistic.write core.receipt composite identities. */
    statisticReceipts: string[];
    nativeVoteRows: number;
  };
  /** Maintained RunStore source baseline, not a fixture label or history count. */
  baseline: { fingerprint: string | null; records: number };
}
export interface VndbStatisticsDriver {
  readonly identity: Pick<ImportIdentity, 'access' | 'database' | 'bulk' | 'client'>;
  /** Auth-issued same-account credential, never a locally signed access token. */
  issue(scopes: readonly string[]): Promise<ImportCredential>;
  /** Only actual source_statistic:write Global grant changes; bearer stays intact. */
  setStatisticGrant(enabled: boolean): Promise<void>;
  run(
    input: AsyncIterable<Uint8Array>,
    options?: {
      credential?: ImportCredential;
      /** Drop first successful statistic response after commit, then normal transport retry. */
      loseStatisticResponse?: boolean;
      disappearanceThreshold?: number;
    },
  ): Promise<{
    outcome: 'committed' | 'invalid-dump' | 'mass-disappearance' | 'denied';
    exchanges: Exchange[];
    /** Captured VndbTablesStore.page output leaves, before registration/Importer. */
    sourceRecords: { key: string; revision: number; average: number | null; count: number }[];
  }>;
  observe(): Promise<Observation>;
  /** Replay exact captured request through public HTTP with its original bearer. */
  replay(request: Exchange): Promise<Exchange>;
  reopen(): Promise<void>;
  close(): Promise<void>;
}
export const MISSING_VNDB_STATISTICS_DRIVER = 'IMPORT_VNDB_STATISTICS_DRIVER is required: native binding missing';
export async function loadVndbStatisticsDriver(): Promise<VndbStatisticsDriver> {
  const location = process.env.IMPORT_VNDB_STATISTICS_DRIVER;
  if (!location) throw new Error(MISSING_VNDB_STATISTICS_DRIVER);
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORT_VNDB_STATISTICS_DRIVER must be an absolute path or file URL');
  const binding = await import(url.href);
  return binding.createVndbStatisticsDriver();
}
