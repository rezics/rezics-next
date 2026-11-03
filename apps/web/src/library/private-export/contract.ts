/** Native private Library export caps, verified against docs/library-export.md and mounted types. */
export const EXPORT_PAGE_ROWS = 16;
export const EXPORT_ROW_BYTES = 65_536;
export const EXPORT_PAGE_RECORD_BYTES = 120_000;
export const EXPORT_STREAM_RECORDS = 100_000;
export const EXPORT_STREAM_BYTES = 32 * 1024 * 1024;
export const EXPORT_CURSOR_CHARS = 4_096;
export const EXPORT_TTL_MINUTES = 15;
export const EXPORT_FORMAT = 'https://rezics.com/formats/library-export';
export const EXPORT_VERSION = 1;
export const EXPORT_PRIVACY = 'private';
export const EXPORT_COMPLETENESS = 'supported-native-facts';
export const SUBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const EXPORT_SECTIONS = [
  'entries',
  'labels',
  'assignments',
  'sessions',
  'units',
  'history',
  'holdings',
  'collections',
  'collectionPins',
  'occurrences',
  'bangumiUploads',
  'bangumiEvidence',
  'malImports',
  'malEvidence',
] as const;

export type ExportSection = (typeof EXPORT_SECTIONS)[number];
export type ExportState = 'collecting' | 'ready' | 'stale' | 'cancelled' | 'expired' | 'limit';
export type ExportJson = string | number | boolean | null | ExportJson[] | { readonly [key: string]: ExportJson };
export type ExportRecord = { readonly [key: string]: ExportJson };

export type ExportOmissions = { readonly [key: string]: string };

export type ExportCoverage = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportId: string;
  capturedAt: string;
  expiresAt: string;
  privacy: typeof EXPORT_PRIVACY;
  completeness: typeof EXPORT_COMPLETENESS;
  sections: string[];
  omissions: ExportOmissions;
  fullExport: false;
};

export type ExportStatus = ExportCoverage & {
  state: ExportState;
  first: string | null;
};

export type ExportManifest = ExportCoverage & {
  rows: number;
  recordBytes: number;
};

export type ExportPage = {
  exportId: string;
  state: ExportState;
  records: ExportRecord[];
  next: string | null;
  manifest: ExportManifest | null;
};

export type ExportArtifact = {
  filename: string;
  mediaType: 'application/json';
  bytes: Uint8Array;
};

export type ExportFailureKind =
  | 'denied'
  | 'unavailable'
  | 'not-found'
  | 'conflict'
  | 'idempotency'
  | 'invalid-cursor'
  | 'malformed';

export type ExportFailure = { kind: ExportFailureKind; detail?: string };
export type ExportUnknown = { kind: 'unknown'; command: ExportCommand };

export type ExportCommand =
  | { kind: 'create'; key: string }
  | { kind: 'status'; exportId: string }
  | { kind: 'page'; exportId: string; cursor: string }
  | { kind: 'cancel'; exportId: string };

export type ExportCreateResult = { kind: 'status'; status: ExportStatus };
export type ExportPageResult = { kind: 'page'; page: ExportPage };
export type ExportCancelResult = { kind: 'cancelled'; status: ExportStatus };
export type ExportPortResult =
  | ExportCreateResult
  | ExportPageResult
  | ExportCancelResult
  | ExportFailure
  | ExportUnknown;

type ExportOutcome<T> = Promise<T | ExportFailure | ExportUnknown>;

export type ExportPort = {
  create(command: Extract<ExportCommand, { kind: 'create' }>): ExportOutcome<ExportCreateResult>;
  status(command: Extract<ExportCommand, { kind: 'status' }>): ExportOutcome<ExportCreateResult>;
  page(command: Extract<ExportCommand, { kind: 'page' }>): ExportOutcome<ExportPageResult>;
  cancel(command: Extract<ExportCommand, { kind: 'cancel' }>): ExportOutcome<ExportCancelResult>;
};

export type ExportFileDelivery = (file: ExportArtifact) => boolean | Promise<boolean>;

export function newCommandKey(): string {
  return crypto.randomUUID();
}

export function quotedIdempotencyKey(key: string): string {
  return JSON.stringify(key);
}

export function sameCommand(left: ExportCommand, right: ExportCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

export function isTerminalState(
  state: ExportState,
): state is Extract<ExportState, 'stale' | 'cancelled' | 'expired' | 'limit'> {
  return state === 'stale' || state === 'cancelled' || state === 'expired' || state === 'limit';
}

export function artifactFilename(exportId: string): string {
  return `rezics-library-export-${exportId}.json`;
}
