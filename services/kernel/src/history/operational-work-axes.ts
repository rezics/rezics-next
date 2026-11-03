/** Shared native dimensions, independent of transaction and selected-runtime initialization. */
export const OPERATIONAL_WORK_AXES = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
] as const;
