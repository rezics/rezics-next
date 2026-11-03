export const VNDB_XML_BYTES = 2 * 1024 * 1024;
export const VNDB_JSON_WIRE_BYTES = 12 * 1024 * 1024 + 64;
export const VNDB_ROWS = 5_000;
export const VNDB_PAGE = 8;
export const VNDB_APPLY = 8;
export const VNDB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type VndbSourceValue = {
  kind: 'missing' | 'unknown' | 'invalid' | 'value';
  raw: string | null;
  value?: string | number;
  precision?: 'year' | 'month' | 'day';
  scale?: { min: number; max: number; step: number };
};

export type VndbState = {
  id: string;
  labels: Record<string, string>;
  role?: 'planned' | 'active' | 'completed' | 'paused' | 'dropped';
};

export type VndbBaseline = { state: string; revision: number; incarnationId: string | null } | null;

export type VndbRow = {
  ordinal: number;
  kind: 'vn' | 'retained';
  identifier: { provider: 'vndb'; kind: 'vn'; value: string } | null;
  title: string;
  labels: string[];
  suggestedRole: string | null;
  fields: Record<string, VndbSourceValue>;
  retainedReason: string;
  evidence: unknown;
  match: { status: 'unsupported'; candidates: string[] } | {
    status: 'ambiguous' | 'matched' | 'unavailable' | 'unmatched';
    candidates: string[];
  };
  target: { targetId: string; states: VndbState[]; baseline: VndbBaseline } | null;
  decision: {
    reviewId: string;
    status: 'applied' | 'applying' | 'failed' | 'reviewed' | 'skipped' | 'stale' | 'unsupported';
    targetId: string | null;
    state: string | null;
    baseline: VndbBaseline;
    replace: boolean;
  } | null;
  fieldsTreatment: { state: string; other: string };
};

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

export type VndbPage = {
  uploadId: string;
  state: 'active' | 'cancelled';
  expiresAt: string;
  total: number;
  next: number | null;
  rows: VndbRow[];
};

export type VndbDecision = NonNullable<VndbRow['decision']>;
export type VndbApplyResult = {
  uploadId: string;
  outcomes: { ordinal: number; reviewId: string; status: string }[];
  stopped: 'cancelled' | 'deadline' | null;
};

export type VndbReviewInput =
  | { ordinal: number; action: 'state'; targetId: string; state: string; replace: boolean }
  | { ordinal: number; action: 'skip' | 'retain' };

export type VndbCommand =
  | { kind: 'preview'; key: string; xml: string }
  | { kind: 'page'; uploadId: string; offset: number }
  | { kind: 'source'; uploadId: string }
  | { kind: 'review'; key: string; uploadId: string; body: VndbReviewInput }
  | { kind: 'apply'; uploadId: string; body: { rows: { ordinal: number; reviewId: string }[] } }
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
  preview(command: Extract<VndbCommand, { kind: 'preview' }>): Promise<{ kind: 'previewed'; value: VndbPreview } | VndbFailure | VndbUnknown>;
  page(command: Extract<VndbCommand, { kind: 'page' }>): Promise<{ kind: 'page'; value: VndbPage } | VndbFailure | VndbUnknown>;
  source(command: Extract<VndbCommand, { kind: 'source' }>): Promise<{ kind: 'source'; xml: string } | VndbFailure | VndbUnknown>;
  review(command: Extract<VndbCommand, { kind: 'review' }>): Promise<{ kind: 'reviewed'; value: VndbDecision } | VndbFailure | VndbUnknown>;
  apply(command: Extract<VndbCommand, { kind: 'apply' }>): Promise<{ kind: 'applied'; value: VndbApplyResult } | VndbFailure | VndbUnknown>;
  cancel(command: Extract<VndbCommand, { kind: 'cancel' }>): Promise<{ kind: 'cancelled' } | VndbFailure | VndbUnknown>;
  delete(command: Extract<VndbCommand, { kind: 'delete' }>): Promise<{ kind: 'deleted' } | VndbFailure | VndbUnknown>;
};

export function newVndbKey(): string {
  return crypto.randomUUID();
}

export function quotedVndbKey(key: string): string {
  return JSON.stringify(key);
}

export function chunkVndbRows<T>(rows: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += VNDB_APPLY) chunks.push(rows.slice(offset, offset + VNDB_APPLY));
  return chunks;
}
