import { createHash } from 'node:crypto';
import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import readFrame from './identity-work-frame-read.sql';
import saveFrame from './identity-work-frame-save.sql';
import readLimit from './identity-work-frame-limit.sql';
import pageVotes from './segment-identity-page.sql';

export const RATING_IDENTITY_PAGE_SIZE = 64;
export type IdentityVoteKey = { questionId: string; targetId: string };
export type IdentityVote = IdentityVoteKey & {
  units: number | null;
  revision: number;
  countedTargetId: string | null;
  countedRevision: number;
  changedAt: string;
};
export type IdentityWorkRef = { workId: string; generation: string };
export type IdentityRepairPage = IdentityWorkRef & {
  pageId: string;
  voterId: string;
  mode: 'repair' | 'withdrawal';
  after: IdentityVoteKey | null;
  through: IdentityVoteKey | null;
  next: IdentityVoteKey | null;
  terminal: boolean;
  votes: IdentityVote[];
  digest: string;
};
export type IdentityWorkFrame = IdentityWorkRef & {
  state: 'active' | 'complete' | 'cancelled';
  mode: IdentityRepairPage['mode'];
  cursor: IdentityVoteKey | null;
  through: IdentityVoteKey | null;
  selected: IdentityRepairPage | null;
};

export function identityRoute(voterId: string): number {
  const route = routeOf(voterId);
  if (route === null) throw new TypeError('Invalid Rating identity voter');
  return route;
}

export function validateIdentityWork(ref: IdentityWorkRef): void {
  if (routeOf(ref.workId) === null || !/^[1-9][0-9]{0,17}$/.test(ref.generation))
    throw new TypeError('Invalid Rating identity work reference');
}

export function sameIdentityWork(frame: IdentityWorkFrame | null, ref: IdentityWorkRef): frame is IdentityWorkFrame {
  return frame !== null && frame.workId === ref.workId && frame.generation === ref.generation;
}

export async function readIdentityFrame(tx: CommandTransaction, voterId: string): Promise<IdentityWorkFrame | null> {
  return (await tx.query<IdentityWorkFrame>(readFrame.sql, [identityRoute(voterId), voterId])).rows[0] ?? null;
}

export async function saveIdentityFrame(
  tx: CommandTransaction,
  voterId: string,
  frame: IdentityWorkFrame,
): Promise<void> {
  await tx.query(saveFrame.sql, [
    identityRoute(voterId),
    voterId,
    frame.generation,
    frame.workId,
    frame.state,
    frame.mode,
    JSON.stringify(frame.cursor),
    JSON.stringify(frame.through),
    frame.selected === null ? null : JSON.stringify(frame.selected),
  ]);
}

export async function readIdentityLimit(tx: CommandTransaction, voterId: string): Promise<IdentityVoteKey | null> {
  return (await tx.query<IdentityVoteKey>(readLimit.sql, [identityRoute(voterId), voterId])).rows[0] ?? null;
}

export async function readIdentityVotes(
  tx: CommandTransaction,
  voterId: string,
  after: IdentityVoteKey | null,
  through: IdentityVoteKey | null,
): Promise<IdentityVote[]> {
  if (through === null) return [];
  const rows = (
    await tx.query<IdentityVote>(pageVotes.sql, [
      identityRoute(voterId),
      voterId,
      after?.questionId ?? null,
      after?.targetId ?? null,
      through.questionId,
      through.targetId,
    ])
  ).rows;
  return rows.map((row) => ({
    ...row,
    units: row.units === null ? null : Number(row.units),
    revision: Number(row.revision),
    countedRevision: Number(row.countedRevision),
  }));
}

export function identityPageDigest(page: Omit<IdentityRepairPage, 'digest'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        page.voterId,
        page.workId,
        page.generation,
        page.pageId,
        page.mode,
        page.after,
        page.through,
        page.next,
        page.terminal,
        page.votes.map((vote) => [
          vote.questionId,
          vote.targetId,
          vote.units,
          vote.revision,
          vote.countedTargetId,
          vote.countedRevision,
          vote.changedAt,
        ]),
      ]),
    )
    .digest('hex');
}
