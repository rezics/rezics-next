import type { DocumentSnapshot } from '../packages/document/src/types';

/**
 * IMPORTED_FIELD_DRIVER: absolute path/file URL exporting createImportedFieldDriver.
 * Each factory owns isolated migrated PG, native DBOS, real Auth-issued JWTs/Access
 * grants and object bytes; close cleans everything, including paused jobs/faults.
 * Requests use real createKernel.handle. Semantic owns the portable bulk schema:
 * refresh/cover map these test inputs to its actual command, never a second API.
 * Persistence/claims execute INSIDE that command's actual CommandTransaction.
 * Inspect authoritative rows, native DB hash constraints, receipts, executed SQL,
 * verified authentication and Sharp calls; never simulate product behavior/policy.
 * Fetch fixtures replace ONLY the external network boundary with real encoded bytes.
 */
export type Persona = 'anonymous' | 'account' | 'importer' | 'governance';
export interface Tuple {
  source: string;
  externalId: string;
  fieldGroup: string;
}
export interface Provenance extends Tuple {
  recordRevision: string;
  digest: string;
  converterRevision: string;
  references: string[];
  rights: { spdx: string; obligations: string[]; attribution: string };
}
export interface Field extends Provenance {
  subjectId: string;
  document: DocumentSnapshot;
}
export interface Reply {
  status: number;
  body: unknown;
}
export interface Contribution {
  id: string;
  revision: string;
  documentId: string;
  digest: string;
  bytes: Uint8Array;
  provenance: Provenance;
  partition: number;
  transactionId: string;
  semantic: { documentId: string; digest: string; body: null; transactionId: string; adoption: 'proposal' };
}
export interface Media {
  id: string;
  uploaderId: string;
  partition: number;
  state: 'available' | 'rejected';
  transitions: string[];
  bytes: Uint8Array;
  storedKeys: string[];
  claimedAt: string | null;
  role: 'cover';
  credit: string;
  sourceLink: string;
  imageLicence: string | null;
}
export interface Trace {
  writes: { partition: number; transactionId: string }[];
  crossPartitionJoins: number;
  fenceChecks: { tuple: Tuple; authoritativeTime: string; beforeReceiptAndBody: boolean }[];
  authorization: { action: string; anchor: string; at: string; allowed: boolean }[];
}
export interface ImageInput {
  sourceUrl: string;
  credit: string;
  provenance: Provenance;
}
export type FetchCase =
  | 'valid'
  | 'unallowed-host'
  | 'unsafe-redirect'
  | 'redirect-limit'
  | 'byte-limit'
  | 'timeout'
  | 'over-pixel'
  | 'malformed';
export interface ImportedFieldDriver {
  readonly importerId: string;
  readonly platformResource: string;
  readonly subject: { id: string; partition: number };
  setTime(at: string): Promise<void>;
  refresh(as: Persona, field: Field, key: string, untrusted?: Record<string, unknown>): Promise<Reply>;
  /** Last command's actual committed contribution; exact historical revision, not head only. */
  contribution(key: string): Promise<Contribution>;
  fence(as: Persona, tuple: Tuple, key: string): Promise<Reply>;
  /** GET /v1/sourceFences:check using the shared customMethod route. */
  check(as: Persona, tuple: Tuple): Promise<Reply>;
  tupleHome(tuple: Tuple): Promise<{ route: number; partition: number }>;
  trace(key: string): Promise<Trace>;
  /** Probe actual native PG hash/check with a savepoint: mismatched bytea/digest must fail. */
  hashEvidence(documentId: string): Promise<{ nativeDigest: string; mismatchedWriteRejected: boolean }>;
  /** Durable content/semantic/media effects + receipts; excludes diagnostics and fixture controls. */
  effects(): Promise<unknown>;
  /** Only protected grant/scope changes; preserve identity, account and other authority. */
  access(as: 'importer' | 'governance', action: string, change: 'revoke-grant' | 'remove-scope'): Promise<void>;
  /** Uses real semantic adoption, then inspect the actual adopted choice. */
  adoptManual(): Promise<string>;
  adopted(): Promise<string>;
  projection(mode: 'pause' | 'drain' | 'replay'): Promise<void>;
  mergeSubject(): Promise<void>;
  /** Actual preparation barrier: fence commits AFTER preparation and BEFORE subject write. */
  race(field: Field, key: string): Promise<{ prepared: boolean; fenceCommittedBeforeWrite: boolean; write: Reply }>;
  disclose(as: Persona): Promise<{ documents: string[]; media: string[]; bodies: string[] }>;
  /** Real direct document exact-revision API: hidden resource returns indistinguishable 404. */
  exact(as: Persona, documentId: string, revision: string): Promise<Reply>;
  fetchFixture(kind: FetchCase): Promise<ImageInput>;
  /** POST /v1/media:importFromUrl {sourceUrl,credit,provenance}; no importer byte relay. */
  importUrl(as: Persona, input: ImageInput, key: string): Promise<Reply>;
  /** Drain native DBOS import/transform/purge jobs, including retry after storage-delete fault. */
  drain(): Promise<void>;
  media(key: string): Promise<Media>;
  /** Early URL denial may create no reservation; inspect real rows and durable storage. */
  rejectedImport(key: string): Promise<{ media: Media | null; storedKeys: string[]; pendingPurge: boolean }>;
  fetchEvidence(key: string): Promise<{ unallowedRequests: string[]; unsafeRequests: string[] }>;
  imageEvidence(key: string): Promise<{
    sub: string;
    principalKind: string;
    websiteSession: boolean;
    tokenExchange: boolean;
    scopes: string[];
    sharpVersion: string;
    sharedPipeline: boolean;
    limitInputPixels: number;
    decoded: { format: string; width: number; height: number; metadata: string[] };
    configuredCaps: { bytes: number; redirects: number; milliseconds: number };
    fetches: string[];
    clientActor: boolean;
  }>;
  /** Actual semantic proposal using AVAILABLE media ID, cover role and credit; no URL value. */
  cover(
    as: Persona,
    mediaId: string,
    key: string,
    fault?: 'invalid-proposal' | 'before-commit' | 'non-cover-role',
  ): Promise<Reply>;
  coverReference(key: string): Promise<{
    mediaId: string;
    role: string;
    credit: string;
    sourceLink: string;
    partition: number;
    claimTransactionId: string;
    commandTransactionId: string;
  }>;
  download(as: Persona, mediaId: string, ifNoneMatch?: string): Promise<Reply>;
  setContainer(mode: 'public' | 'private' | 'taken-down'): Promise<void>;
  rightsTakedown(mediaId: string, tuple: Tuple): Promise<void>;
  failNextPurge(): Promise<void>;
  /** Actual website-only completion endpoint with ordinary importer bearer. */
  completeAsImporter(mediaId: string): Promise<Reply>;
  /**
   * Call shared services/kernel/test/support/growth.ts checkGrowth through REAL API/worker paths.
   * One seed(scale), scales 32/256/2048: grow unrelated SAME-PARTITION catalogue,
   * revision history and media, fixed target neighbourhood, F, refs and doc/image
   * bytes. Separately vary bounded changed rows. Include real hook/fence/reference/
   * import command and native DBOS job overhead plus real Access membership cost.
   * Instrument actual SQL rows/statements/native buffers: constant rows/statements,
   * logarithmic buffers. No elapsed-time gate, disabled planner, alternate evaluator,
   * canned counts or mere self-reported pass. Return the harness's observed samples.
   */
  checkGrowth(input: { scales: [32, 256, 2048]; changedRows: [1, 4]; documentBytes: number }): Promise<{
    harness: 'checkGrowth';
    seedCalls: number[];
    passed: boolean;
    samples: {
      scale: number;
      changedRows: number;
      operation: 'hook' | 'fence' | 'reference' | 'import' | 'job';
      rows: number;
      statements: number;
      buffers: number;
      documentBytes: number;
      imageBytes: number;
      samePartition: boolean;
    }[];
  }>;
  close(): Promise<void>;
}
