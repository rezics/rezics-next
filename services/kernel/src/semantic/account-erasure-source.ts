import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import type { PublicFilterReadContext } from './public-filter-source-contract.ts';
import type { SubjectErasureSourceProof } from './account-erasure-source-contract.ts';

/** Provisional Ad1 producer port. Missing source-local proof stays pending; no local discovery substitute. */
export async function readSubjectErasureSourceProof(
  _deps: Readonly<{ pool: Pool; clock?: () => Date }>,
  _barrier: HistoryBarrier,
  _context: PublicFilterReadContext,
): Promise<SubjectErasureSourceProof | null> {
  return null;
}

export async function verifySubjectErasureSourceProof(
  _tx: CommandTransaction,
  _barrier: HistoryBarrier,
  _proof: SubjectErasureSourceProof,
): Promise<boolean> {
  return false;
}
