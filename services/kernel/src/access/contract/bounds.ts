/** Closed Access work axes and finite call bounds. These allocate no ledger. */

export const ACCESS_WORK_AXES = ['keys', 'points', 'witnesses', 'rows', 'bytes', 'emptySeeks'] as const;
export type AccessWorkAxis = (typeof ACCESS_WORK_AXES)[number];

export type AccessWork = {
  readonly keys: number;
  readonly points: number;
  readonly witnesses: number;
  readonly rows: number;
  readonly bytes: number;
  readonly emptySeeks: number;
};

export const EMPTY_ACCESS_WORK: AccessWork = Object.freeze({
  keys: 0,
  points: 0,
  witnesses: 0,
  rows: 0,
  bytes: 0,
  emptySeeks: 0,
});

/** Eight-axis original-work ledger, structurally compatible with Collection Source. */
export const ORIGINAL_WORK_AXES = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
  'emptySeeks',
] as const satisfies readonly string[];

export type OriginalWorkAxis = (typeof ORIGINAL_WORK_AXES)[number];

export type AccessWorkDimensions = {
  readonly candidateKeys: number;
  readonly nativeRows: number;
  readonly identityMetadataRows: number;
  readonly nativePoints: number;
  readonly witnessKeys: number;
  readonly statements: number;
  readonly bytes: number;
  readonly emptySeeks: number;
};

export const EMPTY_ACCESS_WORK_DIMENSIONS: AccessWorkDimensions = Object.freeze({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
  emptySeeks: 0,
});

/** A selected original has an absolute five-second lifetime. */
export const IDENTITY_ORIGINAL_DEADLINE_MS = 5_000;

export const ACCESS_RESOURCE_PAGE_LIMIT = 100;
export const ACCESS_AVATAR_BATCH_LIMIT = 256;
export const ACCESS_MEMBERSHIP_INVERSE_LIMIT = 64;
export const ACCESS_PARTITION_COUNT = 4_096;
export const ACCESS_ANONYMOUS_PRINCIPAL_ID = '00000000-0000-8000-8000-000000000000';
export const ACCESS_IDENTITY_OBSERVATION_MS = 180_000;
export const ACCESS_HANDLE_CLAIM_MIN = 3;
export const ACCESS_HANDLE_CLAIM_MAX = 64;
export const ACCESS_WORKFLOW_KEY_MIN = 1;
export const ACCESS_WORKFLOW_KEY_MAX = 255;
export const ACCESS_KIND_AUDIENCE_STATEMENT_COUNT = 13;
export const ACCESS_KIND_AUDIENCE_NATIVE_POINTS = 4;

export type AccessWorkDeclaration = {
  readonly work: AccessWorkDimensions;
  readonly engineRequests: 0;
};
