import type { TransferRecoveryKind } from './operator-transfer-recovery';

/** Mounted presentation only. Never put an account, descriptor or reference here. */
export type TransferReturnEntry = Exclude<TransferRecoveryKind, 'none' | 'source-acknowledged-conflict'> | 'review';

/** Keep the first unresolved source send and the latest local outcome, at most two. */
export function rememberTransferReturn(
  entries: TransferReturnEntry[],
  kind: TransferRecoveryKind | 'review',
  localOutcome = false,
): TransferReturnEntry[] {
  if (kind === 'none') return entries;
  const next = kind === 'source-acknowledged-conflict' ? 'source-acknowledged' : kind;
  // Missing/replaced storage is not new evidence about an observed acknowledgement.
  if (entries.length && next === 'unreadable') return entries;
  if (!localOutcome && entries.includes('source-acknowledged')) {
    if (next === 'source-unknown') return entries.includes(next) ? entries : ['source-unknown', 'source-acknowledged'];
    if (next === 'saved-step' || next === 'destination-accepted') return entries;
  }
  if (next === 'source-unknown' && entries.includes(next)) return entries;
  if (entries.at(-1) === next) return entries;
  const unknown = entries.includes('source-unknown');
  const result: TransferReturnEntry[] = unknown && next !== 'source-unknown' ? ['source-unknown', next] : [next];
  return result.length === entries.length && result.every((value, index) => entries[index] === value)
    ? entries
    : result;
}
