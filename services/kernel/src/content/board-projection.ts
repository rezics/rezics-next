import type { Pool } from 'pg';
import type { Effect } from '../events/effects.ts';
import type { BoardId, ThreadId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type BoardCandidateKey = Readonly<{ createdAt: string; id: ThreadId }>;
export type BoardCandidate = Readonly<{
  id: ThreadId;
  boardId: BoardId;
  createdAt: string;
  epoch: number;
  position: bigint;
}>;
export type BoardCandidatePage = Readonly<{
  candidates: readonly BoardCandidate[];
  next: BoardCandidateKey | null;
  epoch: number;
  position: bigint;
}>;

export function createBoardEffect(_pool: Pool): Effect {
  throw unfinishedPort('createBoardEffect');
}

export async function readBoardCandidates(
  _pool: Pool,
  _boardId: BoardId,
  _after: BoardCandidateKey | null,
  _limit: number,
): Promise<BoardCandidatePage> {
  throw unfinishedPort('readBoardCandidates');
}

export async function applyBoardCandidate(_pool: Pool, _candidate: BoardCandidate): Promise<void> {
  throw unfinishedPort('applyBoardCandidate');
}
