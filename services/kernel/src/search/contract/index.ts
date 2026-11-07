/** Search execution operands; the native bridge settles into the original caller root. */
export type ScopeExecutionDimensions = Readonly<{
  candidateKeys: number;
  nativeRows: number;
  identityMetadataRows: number;
  emptySeeks: number;
  nativePoints: number;
  witnessKeys: number;
  statements: number;
  bytes: number;
}>;
export type ScopeExecutionLedger = {
  remaining(): { readonly remaining: ScopeExecutionDimensions };
  consume(value: ScopeExecutionDimensions): void;
};
export const scopeWorkAxes = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
] as const;
export function zeroScopeWork(): ScopeExecutionDimensions {
  return {
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  };
}
