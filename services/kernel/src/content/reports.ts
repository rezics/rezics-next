import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { Anchored, ContentId, Page, PostId, ReportId, RequestContext, ThreadId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type ReportTarget = Readonly<{ kind: 'thread' | 'post' | 'media'; id: string }>;
export type ReportView = Readonly<{
  id: ReportId;
  reporterId: ContentId;
  target: ReportTarget;
  category: string;
  detail: string | null;
  createdAt: string;
  state: 'open' | 'closed';
}>;
export type ReportInput = Readonly<{ target: ReportTarget; category: string; detail?: string }>;
export type ReportDependencies = Readonly<{ pool: Pool; access: Access }>;
export type ReportReceipt = Readonly<{ receiptId: string; reportId: ReportId }>;

export async function createReport(
  _dependencies: ReportDependencies,
  _actor: Actor,
  _input: ReportInput,
  _context: RequestContext,
): Promise<Readonly<{ receipt: ReportReceipt; reportId: ReportId }>> {
  throw unfinishedPort('createReport');
}

export async function readReport(
  _dependencies: ReportDependencies,
  _reportId: ReportId,
  _actor: Actor,
): Promise<Anchored<ReportView | null>> {
  throw unfinishedPort('readReport');
}

export async function listTargetReports(
  _dependencies: ReportDependencies,
  _target: ReportTarget,
  _actor: Actor,
  _cursor?: string,
  _limit?: number,
): Promise<Page<ReportView>> {
  throw unfinishedPort('listTargetReports');
}

export type ReportTargetIds = Readonly<{ threadId?: ThreadId; postId?: PostId }>;
