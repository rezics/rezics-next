import type { Pool } from 'pg';
import { type CommandOutcome } from '../command/command.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { TurnstileVerifier } from './turnstile.ts';
import type { Anchored, BoardId, Page, PostId, ReportId, RequestContext, RevisionId, ThreadId } from './model.ts';
export type ReportTarget = Readonly<{
    kind: 'board';
    id: BoardId;
}> | Readonly<{
    kind: 'thread';
    id: ThreadId;
}> | Readonly<{
    kind: 'post';
    id: PostId;
}>;
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
    outcome: 'actioned' | 'dismissed' | null;
    resolvedAt: string | null;
    transactionId: string;
    reporterId: string | null;
}>;
export type ReportDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    clock?: () => Date;
    anonymousVerifier?: TurnstileVerifier;
}>;
/** Ephemeral admission credential. Implementations must verify it once and never persist it. */
export type ReportRequestContext = RequestContext & Readonly<{
    botToken?: string;
}>;
type ReadContext = Readonly<{
    actor: Actor;
    deadline: number;
}>;
export declare class ReportUnavailableError extends Error {
    constructor();
}
export declare class ReportProofRequiredError extends Error {
    constructor();
}
export declare class ReportProofUnavailableError extends Error {
    constructor();
}
export declare function createReport(dependencies: ReportDependencies, actor: Actor, input: ReportInput, context: ReportRequestContext): Promise<CommandOutcome<Readonly<{
    reportId: ReportId;
}>>>;
export declare function readReport(dependencies: ReportDependencies, reportId: ReportId, context: ReadContext): Promise<Anchored<ReportView | null>>;
export declare function listTargetReports(dependencies: ReportDependencies, target: ReportTarget, context: ReadContext, cursor?: string, limit?: number): Promise<Page<ReportView>>;
export {};
