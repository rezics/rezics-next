import type { BanReading } from './reading.ts';

export const STATEMENT_LIMIT = 2000;

export type BanSchedule = 'permanent' | 'until' | 'ended';

/** Whether the ban is still in force. A missing end date is permanent, matching the appeal read. */
export function banSchedule(reading: Pick<BanReading, 'permanent' | 'bannedUntil'>, now: number): BanSchedule {
  if (reading.permanent || reading.bannedUntil === null) return 'permanent';
  const ends = Date.parse(reading.bannedUntil);
  if (Number.isNaN(ends) || ends > now) return 'until';
  return 'ended';
}

export type StatementProblem = 'empty' | 'long';

/** The appeal command accepts one trimmed statement of 1 to 2,000 characters. */
export function statementProblem(value: string): StatementProblem | null {
  const text = value.trim();
  if (text.length < 1) return 'empty';
  if (text.length > STATEMENT_LIMIT) return 'long';
  return null;
}

export type AppealPresentation =
  | { kind: 'appeal' }
  | { kind: 'received'; statement: string }
  | { kind: 'upheld'; statement: string; rationale: string | null; decidedAt: string | null }
  | {
    kind: 'reversed';
    statement: string;
    rationale: string | null;
    decidedAt: string | null;
    liftedAt: string | null;
  };

/** What the member can do next. A receipt offers one appeal, then only the outcome. */
export function appealPresentation(reading: BanReading): AppealPresentation {
  if (reading.appeal.state === 'none') return { kind: 'appeal' };
  if (reading.appeal.state === 'open') return { kind: 'received', statement: reading.appeal.statement };
  const decided = {
    statement: reading.appeal.statement,
    rationale: reading.appeal.rationale,
    decidedAt: reading.appeal.decidedAt,
  };
  if (reading.appeal.outcome === 'reversed') {
    return { kind: 'reversed', ...decided, liftedAt: reading.appeal.liftedAt };
  }
  return { kind: 'upheld', ...decided };
}

export function offersAnotherAppeal(reading: BanReading): boolean {
  return appealPresentation(reading).kind === 'appeal';
}

const progress = (reading: BanReading) =>
  reading.appeal.state === 'decided' ? 2 : reading.appeal.state === 'open' ? 1 : 0;

/**
 * A submit can learn the open appeal before the next server render does.
 * A later resolution from the server replaces that optimistic reading.
 */
export function shownReading(server: BanReading, pending: BanReading | null): BanReading {
  if (!pending || pending.receiptId !== server.receiptId) return server;
  return progress(pending) > progress(server) ? pending : server;
}
