/** Private original facts, reduced only after the caller closes the current canonical fibre. */
export type EntryStateCandidate = {
  subjectId: string;
  state: string | null;
  ownerWriteSeq: bigint | null;
};

/** A null state is an ordered clear, not missing evidence or a presence supporter. */
export function newestEntryState<T extends EntryStateCandidate>(entries: Iterable<T>): T | null | 'not_proven' {
  let winner: T | null = null;
  for (const entry of entries) {
    if (entry.ownerWriteSeq === null || entry.ownerWriteSeq <= 0n) return 'not_proven';
    if (winner?.ownerWriteSeq === entry.ownerWriteSeq) return 'not_proven';
    if (winner === null || entry.ownerWriteSeq > winner.ownerWriteSeq!) winner = entry;
  }
  return winner;
}
