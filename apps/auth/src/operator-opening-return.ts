export type OpeningReturnPhase =
  | 'review'
  | 'preflight'
  | 'approval'
  | 'possibly-sent'
  | 'acknowledged'
  | 'unconfirmed'
  | 'refused';

export type OpeningReturnEntry = Exclude<OpeningReturnPhase, 'preflight'>;

const maximumEntries = 6;

/** Keep only a bounded, nonsecret account of distinct outcomes in mounted memory. */
export function appendOpeningReturnEntry(
  entries: readonly OpeningReturnEntry[],
  phase: OpeningReturnPhase,
): OpeningReturnEntry[] {
  const entry = phase === 'preflight' ? 'approval' : phase;
  return entries.includes(entry) ? [...entries] : [...entries, entry].slice(-maximumEntries);
}

export function openingMayStillBeRunning(phase: OpeningReturnPhase | null): boolean {
  return phase === 'possibly-sent' || phase === 'unconfirmed';
}
