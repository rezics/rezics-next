export const MAL_UPLOAD_BYTES = 2_097_152;
export const MAL_WIRE_BYTES = 4_194_304;
export const MAL_PAGE = 20;
export const MAL_ROWS = 500;
export const MAL_FIELD_CAP = 64;
export const MAL_UPLOADS = 3;
export const SUBJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MalValue = {
  kind: 'missing' | 'unknown' | 'invalid' | 'zero' | 'value';
  raw?: string;
  value?: string | number;
  precision?: 'year' | 'month' | 'day';
  scale?: { min: number; max: number; step: number };
};

export type MalMatch = 'matched' | 'already-matched' | 'unmatched' | 'unavailable' | 'ambiguous';
export type MalOutcomeStatus = 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';

export type MalReview = {
  version: string;
  target: string | null;
  skip: boolean;
  replace: boolean;
  state: string | null;
  current: { state: string; revision: number; incarnationId: string | null } | null;
  binding: { subject: string; route: number; source: string; externalId: string } | null;
  source: { release: string; epoch: string; acceptingType: string } | null;
  conflict: boolean;
  unsupported: string | null;
};

export type MalOutcome = {
  row: number;
  status: MalOutcomeStatus;
  applied: string[];
  retained: string[];
  reason: string | null;
};

export type MalPreviewRow = {
  index: number;
  kind: 'anime' | 'manga';
  title: string;
  identifier: { namespace: string; source: string; value: string };
  status: MalValue;
  role: string | null;
  score: MalValue;
  progress: Record<string, MalValue>;
  dates: Record<string, MalValue>;
  notes: MalValue;
  tags: MalValue;
  repeats: MalValue;
  privacy: MalValue;
  timestamps: Record<string, MalValue>;
  fields: Record<string, string>;
  retained: { field: string; reason: string }[];
  target: string | null;
  candidates: { subjectId: string }[];
  match: MalMatch;
  state: string | null;
  current: { state: string; revision: number; incarnationId: string | null } | null;
  binding: MalReview['binding'];
  source: MalReview['source'];
  review: MalReview | null;
  outcome: MalOutcome | null;
};

export type MalLimits = {
  bytes: number;
  wireBytes?: number;
  rows: number;
  page: number;
  uploads?: number;
};

export type MalPage = {
  id: string;
  canceled: boolean;
  total: number;
  rows: MalPreviewRow[];
  sourcePath: string;
  next: number | null;
  limits: MalLimits;
};

export type MalApplyBody = {
  confirm: true;
  rows: { row: number; version: string; fields: string[] }[];
};

export type MalApplyPage = {
  id: string;
  outcomes: MalOutcome[];
  remaining: number[];
  stopped: boolean;
};

export type MalReviewInput = { row: number; target: string | null; skip: boolean; replace: boolean };

export type MalCommand =
  | { kind: 'preview'; key: string; xml: string }
  | { kind: 'page'; id: string; after: number }
  | { kind: 'review'; key: string; id: string; input: MalReviewInput }
  | { kind: 'apply'; id: string; body: MalApplyBody }
  | { kind: 'cancel'; key: string; id: string }
  | { kind: 'delete'; key: string; id: string };

export type MalFailureKind =
  | 'denied'
  | 'unavailable'
  | 'malformed'
  | 'too-large'
  | 'security'
  | 'conflict'
  | 'not-found'
  | 'idempotency';

export type MalFailure = { kind: MalFailureKind; detail?: string };
export type MalUnknown = { kind: 'unknown'; command: MalCommand };

export type MalPreviewResult = { kind: 'previewed'; id: string } | MalFailure | MalUnknown;
export type MalPageResult = { kind: 'page'; page: MalPage } | MalFailure | MalUnknown;
export type MalReviewResult = { kind: 'reviewed'; id: string } | MalFailure | MalUnknown;
export type MalApplyResult = { kind: 'applied'; result: MalApplyPage } | MalFailure | MalUnknown;
export type MalMutateResult = { kind: 'done'; id: string } | MalFailure | MalUnknown;

export type MalImportPort = {
  preview(command: Extract<MalCommand, { kind: 'preview' }>): Promise<MalPreviewResult>;
  page(command: Extract<MalCommand, { kind: 'page' }>): Promise<MalPageResult>;
  review(command: Extract<MalCommand, { kind: 'review' }>): Promise<MalReviewResult>;
  apply(command: Extract<MalCommand, { kind: 'apply' }>): Promise<MalApplyResult>;
  cancel(command: Extract<MalCommand, { kind: 'cancel' }>): Promise<MalMutateResult>;
  delete(command: Extract<MalCommand, { kind: 'delete' }>): Promise<MalMutateResult>;
};

export function newCommandKey(): string {
  return crypto.randomUUID();
}

export function sameCommand(left: MalCommand, right: MalCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
