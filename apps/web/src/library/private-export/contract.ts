/** Native private Library export caps, verified against the installed generated contract. */
export const EXPORT_PAGE_ROWS = 16;
export const EXPORT_ROW_BYTES = 65_536;
export const EXPORT_PAGE_RECORD_BYTES = 120_000;
export const EXPORT_STREAM_RECORDS = 100_000;
export const EXPORT_STREAM_BYTES = 32 * 1024 * 1024;
export const EXPORT_CURSOR_CHARS = 4_096;
export const EXPORT_TTL_MINUTES = 15;
export const EXPORT_FORMAT = 'https://rezics.com/formats/library-export';
export const EXPORT_VERSION = 2 as const;
export const EXPORT_V2_COVERAGE = 'private-library-owner-facts-v2' as const;
export const EXPORT_PRIVACY = 'private';
export const EXPORT_COMPLETENESS = 'supported-native-facts';
export const SUBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const EXPORT_SECTIONS_V1 = [
  'entries',
  'labels',
  'assignments',
  'sessions',
  'holdings',
  'collections',
  'collectionPins',
  'bangumiUploads',
  'bangumiEvidence',
  'malImports',
  'units',
  'history',
  'occurrences',
  'malEvidence',
] as const;

export const EXPORT_SECTIONS_V2 = [...EXPORT_SECTIONS_V1, 'annotations', 'provenance', 'journals'] as const;

/** Historical alias retained for callers that need the original version 1 coverage. */
export const EXPORT_SECTIONS = EXPORT_SECTIONS_V1;
export type ExportVersion = 1 | 2;
export type ExportSectionV1 = (typeof EXPORT_SECTIONS_V1)[number];
export type ExportSection = (typeof EXPORT_SECTIONS_V2)[number];
export type ExportState = 'collecting' | 'ready' | 'stale' | 'cancelled' | 'expired' | 'limit';
export type ExportJson = string | number | boolean | null | ExportJson[] | { readonly [key: string]: ExportJson };
export type ExportRecord = { readonly section: ExportSection; readonly [key: string]: ExportJson };

export const EXPORT_OMISSION_KEYS = [
  'trash',
  'providerIdentifiers',
  'personalImportEvidence',
  'commerce',
  'publication',
  'reimport',
] as const;
export type ExportOmissionKey = (typeof EXPORT_OMISSION_KEYS)[number];
export type ExportOmissions = { readonly [key in ExportOmissionKey]: string };

type ExportCoverageCommon = {
  format: typeof EXPORT_FORMAT;
  exportId: string;
  capturedAt: string;
  expiresAt: string;
  privacy: typeof EXPORT_PRIVACY;
  completeness: typeof EXPORT_COMPLETENESS;
  omissions: ExportOmissions;
  fullExport: false;
};

export type ExportCoverageV1 = ExportCoverageCommon & {
  version: 1;
  sections: ExportSectionV1[];
};

export type ExportCoverageV2 = ExportCoverageCommon & {
  version: 2;
  coverage: typeof EXPORT_V2_COVERAGE;
  sections: ExportSection[];
};

export type ExportCoverage = ExportCoverageV1 | ExportCoverageV2;
export type ExportStatus = ExportCoverage & { state: ExportState; first: string | null };

export type ExportSectionTotal = { rows: number; recordBytes: number };
export type ExportSectionTotals = { readonly [section in ExportSection]: ExportSectionTotal };

export type ExportManifestV1 = ExportCoverageV1 & { rows: number; recordBytes: number };
export type ExportManifestV2 = ExportCoverageV2 & {
  rows: number;
  recordBytes: number;
  sectionTotals: ExportSectionTotals;
};
export type ExportManifest = ExportManifestV1 | ExportManifestV2;

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

export function encodedRecordBytes(record: ExportRecord): number {
  return encodedBytes(record);
}

export function exportCoverage(value: ExportCoverage): ExportCoverage {
  const common = {
    format: value.format,
    exportId: value.exportId,
    capturedAt: value.capturedAt,
    expiresAt: value.expiresAt,
    privacy: value.privacy,
    completeness: value.completeness,
    omissions: { ...value.omissions },
    fullExport: false as const,
  };
  if (value.version === 1) return { ...common, version: 1, sections: [...value.sections] };
  return { ...common, version: 2, coverage: value.coverage, sections: [...value.sections] };
}

export function sameExportCoverage(left: ExportCoverage, right: ExportCoverage): boolean {
  if (
    left.version !== right.version ||
    left.format !== right.format ||
    left.exportId !== right.exportId ||
    left.capturedAt !== right.capturedAt ||
    left.expiresAt !== right.expiresAt ||
    left.privacy !== right.privacy ||
    left.completeness !== right.completeness ||
    left.fullExport !== right.fullExport ||
    left.sections.length !== right.sections.length ||
    left.sections.some((section, index) => section !== right.sections[index])
  )
    return false;
  if (left.version === 2 && (right.version !== 2 || left.coverage !== right.coverage)) return false;
  const leftKeys = Object.keys(left.omissions);
  const rightKeys = Object.keys(right.omissions);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right.omissions, key) && left.omissions[key as ExportOmissionKey] === right.omissions[key as ExportOmissionKey])
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is ExportJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (!isObject(value)) return false;
  return Object.values(value).every(isJson);
}

function exactSections(value: unknown, expected: readonly string[]): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((section, index) => section === expected[index])
  );
}

function validCaptureWindow(capturedAt: unknown, expiresAt: unknown): boolean {
  if (typeof capturedAt !== 'string' || typeof expiresAt !== 'string') return false;
  const start = Date.parse(capturedAt);
  const end = Date.parse(expiresAt);
  return Number.isFinite(start) && Number.isFinite(end) && end - start === EXPORT_TTL_MINUTES * 60_000;
}

function validOmissions(value: unknown): value is ExportOmissions {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === EXPORT_OMISSION_KEYS.length &&
    EXPORT_OMISSION_KEYS.every((key) => Object.hasOwn(value, key) && typeof value[key] === 'string')
  );
}

export function isExportCoverage(value: unknown): value is ExportCoverage {
  if (!isObject(value)) return false;
  if (
    value.format !== EXPORT_FORMAT ||
    typeof value.exportId !== 'string' ||
    !SUBJECT_ID.test(value.exportId) ||
    !validCaptureWindow(value.capturedAt, value.expiresAt) ||
    value.privacy !== EXPORT_PRIVACY ||
    value.completeness !== EXPORT_COMPLETENESS ||
    value.fullExport !== false ||
    !validOmissions(value.omissions)
  )
    return false;
  if (value.version === 1)
    return !Object.hasOwn(value, 'coverage') && exactSections(value.sections, EXPORT_SECTIONS_V1);
  return (
    value.version === 2 &&
    value.coverage === EXPORT_V2_COVERAGE &&
    exactSections(value.sections, EXPORT_SECTIONS_V2)
  );
}

export function isExportStatus(value: unknown): value is ExportStatus {
  if (!isObject(value) || !isExportCoverage(value) || !isExportState(value.state)) return false;
  return (
    value.first === null ||
    (typeof value.first === 'string' && value.first.length > 0 && value.first.length <= EXPORT_CURSOR_CHARS)
  );
}

function validCount(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= maximum;
}

function validSectionTotals(value: unknown, rows: number, recordBytes: number): value is ExportSectionTotals {
  if (!isObject(value) || Object.keys(value).length !== EXPORT_SECTIONS_V2.length) return false;
  let totalRows = 0;
  let totalBytes = 0;
  for (const section of EXPORT_SECTIONS_V2) {
    if (!Object.hasOwn(value, section)) return false;
    const total = value[section];
    if (!isObject(total) || !validCount(total.rows, EXPORT_STREAM_RECORDS) || !validCount(total.recordBytes, EXPORT_STREAM_BYTES))
      return false;
    totalRows += total.rows;
    totalBytes += total.recordBytes;
  }
  return totalRows === rows && totalBytes === recordBytes;
}

export function isExportManifest(value: unknown): value is ExportManifest {
  if (!isObject(value) || !isExportCoverage(value)) return false;
  if (!validCount(value.rows, EXPORT_STREAM_RECORDS) || !validCount(value.recordBytes, EXPORT_STREAM_BYTES)) return false;
  if (value.version === 1) return !Object.hasOwn(value, 'sectionTotals');
  return validSectionTotals(value.sectionTotals, value.rows, value.recordBytes);
}

export function isExportRecord(value: unknown): value is ExportRecord {
  return isObject(value) && typeof value.section === 'string' && (EXPORT_SECTIONS_V2 as readonly string[]).includes(value.section) && isJson(value);
}

export function isExportState(value: unknown): value is ExportState {
  return (
    value === 'collecting' ||
    value === 'ready' ||
    value === 'stale' ||
    value === 'cancelled' ||
    value === 'expired' ||
    value === 'limit'
  );
}

export function isTerminalState(state: ExportState): state is Extract<ExportState, 'stale' | 'cancelled' | 'expired' | 'limit'> {
  return state === 'stale' || state === 'cancelled' || state === 'expired' || state === 'limit';
}

export function isExportPage(value: unknown): value is ExportPage {
  if (!isObject(value) || typeof value.exportId !== 'string' || !SUBJECT_ID.test(value.exportId)) return false;
  if (!isExportState(value.state) || !Array.isArray(value.records) || value.records.length > EXPORT_PAGE_ROWS) return false;
  if (
    value.next !== null &&
    (typeof value.next !== 'string' || value.next.length === 0 || value.next.length > EXPORT_CURSOR_CHARS)
  )
    return false;
  if (value.manifest !== null && !isExportManifest(value.manifest)) return false;
  if (!value.records.every(isExportRecord)) return false;
  if (isTerminalState(value.state))
    return value.records.length === 0 && value.next === null && value.manifest === null;
  if (value.state === 'ready') return value.next === null && value.manifest !== null;
  return value.next !== null && value.manifest === null;
}

export function artifactFilename(exportId: string): string {
  return `rezics-library-export-${exportId}.json`;
}
