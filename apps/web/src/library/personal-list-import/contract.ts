import type { KernelClient } from '@rezics/client';

type UploadedVndb = ReturnType<KernelClient['libraryImports']['vndb']>;
export type GeneratedVndbReview = Parameters<UploadedVndb['$review']['post']>[0];
export type GeneratedVndbApply = Parameters<UploadedVndb['$apply']['post']>[0];
export type GeneratedVndbPage = NonNullable<Awaited<ReturnType<UploadedVndb['get']>>['data']>;
export type GeneratedVndbDecision = NonNullable<Awaited<ReturnType<UploadedVndb['$review']['post']>>['data']>;
export type GeneratedVndbApplyResult = NonNullable<Awaited<ReturnType<UploadedVndb['$apply']['post']>>['data']>;

/** Absent producer fields stay uninhabitable until the installed generated contract publishes them. */
type PublishedField<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
export type GeneratedVndbScoreReview = Extract<GeneratedVndbReview, { action: 'score' }>;
export type GeneratedVndbNativeScore = PublishedField<GeneratedVndbPage['rows'][number], 'nativeScore'>;
export type GeneratedVndbScoreDecision = PublishedField<GeneratedVndbPage['rows'][number], 'scoreDecision'>;
export type GeneratedVndbScoreApplyRow = Extract<GeneratedVndbApply['rows'][number], { scoreReviewId: string }>;
export type GeneratedVndbScoreApplyOutcome = Extract<
  GeneratedVndbApplyResult['outcomes'][number],
  { scoreReviewId: string }
>;

export const VNDB_XML_BYTES = 2 * 1024 * 1024;
export const VNDB_JSON_WIRE_BYTES = 12 * 1024 * 1024 + 64;
export const VNDB_ROWS = 5_000;
export const VNDB_PAGE = 8;
export const VNDB_APPLY = 8;
export const VNDB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keep native fields intact; the decoder additionally admits only JSON source evidence. */
export type VndbRow = GeneratedVndbPage['rows'][number] & { evidence: VndbJson };
export type VndbSourceValue = VndbRow['fields'][string];
export type VndbState = NonNullable<VndbRow['target']>['states'][number];
export type VndbBaseline = NonNullable<VndbRow['target']>['baseline'];
export type VndbJson = null | boolean | number | string | VndbJson[] | { [key: string]: VndbJson };

export type VndbPreview = {
  uploadId: string;
  rows: number;
  limits: {
    bytes: number;
    wireBytes: number;
    depth: number;
    rows: number;
    evidenceBytes: number;
    page: number;
    uploads: number;
    lifetimeMs: number;
    applyMs: number;
  };
};

export type VndbPage = Omit<GeneratedVndbPage, 'rows'> & { rows: VndbRow[] };
export type VndbDecision = Extract<GeneratedVndbDecision, { state: string | null }>;
export type VndbScoreDecision = NonNullable<VndbRow['scoreDecision']>;
export type VndbReviewResult = GeneratedVndbDecision;
/** Keep both independent review identities exactly as published by the native importer. */
export type VndbApplyRow = GeneratedVndbApply['rows'][number];
export type VndbOutcome = GeneratedVndbApplyResult['outcomes'][number];
export type VndbApplyResult = GeneratedVndbApplyResult;

/** The native route publishes state, score, skip and retain choices; never add local wire fields here. */
export type VndbReviewInput = GeneratedVndbReview;

export type VndbCommand =
  | { kind: 'preview'; key: string; xml: string }
  | { kind: 'page'; uploadId: string; offset: number }
  | { kind: 'source'; uploadId: string }
  | { kind: 'review'; key: string; uploadId: string; body: VndbReviewInput }
  | { kind: 'apply'; uploadId: string; body: Omit<GeneratedVndbApply, 'rows'> & { rows: VndbApplyRow[] } }
  | { kind: 'cancel'; key: string; uploadId: string }
  | { kind: 'delete'; key: string; uploadId: string };

export type VndbFailureKind =
  | 'admission'
  | 'wire-too-large'
  | 'denied'
  | 'not-found'
  | 'conflict'
  | 'idempotency'
  | 'rejected'
  | 'unavailable';

export type VndbFailure = { kind: VndbFailureKind; status: number; code?: string };
export type VndbUnknown = { kind: 'unknown'; command: VndbCommand };

export type VndbPort = {
  preview(
    command: Extract<VndbCommand, { kind: 'preview' }>,
  ): Promise<{ kind: 'previewed'; value: VndbPreview } | VndbFailure | VndbUnknown>;
  page(
    command: Extract<VndbCommand, { kind: 'page' }>,
  ): Promise<{ kind: 'page'; value: VndbPage } | VndbFailure | VndbUnknown>;
  source(
    command: Extract<VndbCommand, { kind: 'source' }>,
  ): Promise<{ kind: 'source'; xml: string } | VndbFailure | VndbUnknown>;
  review(
    command: Extract<VndbCommand, { kind: 'review' }>,
  ): Promise<{ kind: 'reviewed'; value: VndbReviewResult } | VndbFailure | VndbUnknown>;
  apply(
    command: Extract<VndbCommand, { kind: 'apply' }>,
  ): Promise<{ kind: 'applied'; value: VndbApplyResult } | VndbFailure | VndbUnknown>;
  cancel(command: Extract<VndbCommand, { kind: 'cancel' }>): Promise<{ kind: 'cancelled' } | VndbFailure | VndbUnknown>;
  delete(command: Extract<VndbCommand, { kind: 'delete' }>): Promise<{ kind: 'deleted' } | VndbFailure | VndbUnknown>;
};

export function newVndbKey(): string {
  return crypto.randomUUID();
}

/** Detach mutable form inputs before retaining retry authority for this visit. */
export function freezeVndbCommand<T extends VndbCommand>(command: T): T {
  const copy = structuredClone(command);
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(copy);
  return copy;
}

export function quotedVndbKey(key: string): string {
  return JSON.stringify(key);
}

export function chunkVndbRows<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += VNDB_APPLY) chunks.push(rows.slice(offset, offset + VNDB_APPLY));
  return chunks;
}
