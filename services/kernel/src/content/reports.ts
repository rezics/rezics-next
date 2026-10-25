import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { Anchored, BoardId, Page, PostId, ReportId, RequestContext, RevisionId, ThreadId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type ReportTarget =
  | Readonly<{ kind: 'board'; id: BoardId }>
  | Readonly<{ kind: 'thread'; id: ThreadId }>
  | Readonly<{ kind: 'post'; id: PostId }>;
export type ReportInput = Readonly<{
  target: ReportTarget;
  revisionId?: RevisionId;
  reason: string;
  evidence?: string;
}>;
export type ReportView = Readonly<{
  id: ReportId;
  partition: number;
  target: ReportTarget;
  revisionId: RevisionId | null;
  reason: string;
  evidence: string | null;
  createdAt: string;
  transactionId: string;
  reporterId: string | null;
}>;
export type ReportDependencies = Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array; clock?: () => Date }>;
export type ReportRequestContext = RequestContext & Readonly<{ trustedAnonymousAdmission?: object }>;
export function createReport(
  _dependencies: ReportDependencies,
  _actor: Actor,
  _input: ReportInput,
  _context: RequestContext,
): Promise<CommandOutcome<Readonly<{ reportId: ReportId }>>> {
  throw unfinishedPort('createReport');
}
export function readReport(
  _dependencies: ReportDependencies,
  _reportId: ReportId,
  _context: Readonly<{ actor: Actor; deadline: number }>,
): Promise<Anchored<ReportView | null>> {
  throw unfinishedPort('readReport');
}
export function listTargetReports(
  _dependencies: ReportDependencies,
  _target: ReportTarget,
  _context: Readonly<{ actor: Actor; deadline: number }>,
  _cursor?: string,
  _limit?: number,
): Promise<Page<ReportView>> {
  throw unfinishedPort('listTargetReports');
}
