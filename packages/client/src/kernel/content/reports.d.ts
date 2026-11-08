import type { Pool } from 'pg';
import { type CommandOutcome } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
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
}> | Readonly<{
    kind: 'subject';
    id: string;
}> | Readonly<{
    kind: 'space';
    id: string;
}> | Readonly<{
    kind: 'realm';
    id: string;
}>;
export declare const CATALOGUE_REPORT_PAGE_LIMIT = 50;
export declare const SUBJECT_REPORT_INSPECTIONS_PER_CANDIDATE = 4;
export declare const CATALOGUE_REPORT_SNAPSHOT_CEILING: number;
export type ReportSelection = Readonly<{
    status?: 'all' | 'pending' | 'resolved';
    targetKind?: 'all' | ReportTarget['kind'];
    order?: 'newest' | 'oldest';
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
/** The reporter's submitted record, without moderator-only storage metadata. */
export type ReporterReportView = Pick<ReportView, 'id' | 'target' | 'revisionId' | 'reason' | 'evidence' | 'reporterId' | 'createdAt' | 'outcome' | 'resolvedAt'> & Readonly<{
    targetAvailability: 'available' | 'unavailable';
}>;
export type ReportReadView = ReportView | ReporterReportView;
export type ReportDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    clock: () => Date;
    deadlineNow?: () => number;
    anonymousVerifier?: TurnstileVerifier;
}>;
/** Ephemeral admission credential. Implementations must verify it once and never persist it. */
export type ReportRequestContext = RequestContext & Readonly<{
    botToken?: string;
}>;
export type ReportReadContext = Readonly<{
    actor: Actor;
    deadline: number;
}>;
type ReadContext = ReportReadContext;
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
/** Reporter retention uses the native current account policy independently of
 * target readership and inspection. This is also the own-inventory admission. */
export declare function reporterHistoryAuthority(dependencies: ReportDependencies, context: ReadContext): Promise<Anchored<boolean>>;
/** Private submitted fields come from the original cases, grouped by native
 * home, only after current recipient authorization on every fill/recheck. */
export declare function readReporterHistoryCases(dependencies: ReportDependencies, ids: readonly string[], context: ReadContext): Promise<ReadonlyMap<string, ReportView>>;
export declare function readReport(dependencies: ReportDependencies, reportId: ReportId, context: ReadContext): Promise<Anchored<ReportView | null>>;
/** Exact moderator selection. Authorization is checked on the report's parent
 * before the private row is retained; a missing current target does not turn a
 * retained, independently authorized report into a concealed report. */
export declare function readModerationReportReference(dependencies: ReportDependencies, reportId: ReportId, context: ReadContext): Promise<Anchored<ReportView | null>>;
export type ReportTargetInspection = Readonly<{
    state: 'available' | 'taken-down' | 'erased' | 'withheld' | 'unavailable';
    value: unknown | null;
    destination: Readonly<{
        boardId: string;
        threadId?: string;
        realmId?: string;
    }> | null;
}>;
/** One exact current-target read and, when recorded, one exact historical post
 * revision read. Current destination disclosure is a separate native read. */
export declare function readReportTargetInspection(dependencies: ReportDependencies, report: ReportView, context: ReadContext): Promise<Readonly<{
    current: ReportTargetInspection;
    reportedRevision: ReportTargetInspection;
}>>;
/** Advice is a current read only; dismiss and takedown writers reauthorize the
 * original report and target when their existing command is submitted. */
export declare function readReportActionAdvice(dependencies: ReportDependencies, report: ReportView, current: ReportTargetInspection, context: ReadContext): Promise<Readonly<{
    dismiss: boolean;
    takeDown: boolean;
}>>;
/** Minimal current projection for an outcome notice owned by its reporter.
 * It does not load report reason/evidence or inspect the target body. */
export declare function readReporterNoticeOutcome(dependencies: ReportDependencies, reportId: ReportId, context: ReadContext): Promise<{
    anchor: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>;
    value: {
        id: string;
        target: {
            kind: "board" | "post" | "realm" | "space" | "subject" | "thread";
            id: string;
        };
        threadId: string | null;
        outcome: "actioned" | "dismissed" | null;
        resolvedAt: string | null;
        reporterId: string | null;
    };
} | null>;
/** Closed reporter projection, independent of the required moderator/list fields. */
export declare function reportReadView(report: ReportView): ReportReadView;
export declare function listTargetReports(dependencies: ReportDependencies, target: ReportTarget, context: ReadContext, cursor?: string, limit?: number): Promise<Page<ReportView>>;
/** Additive selection adapter; the original native list contract retains its defaults. */
export declare function listSelectedTargetReports(dependencies: ReportDependencies, target: ReportTarget, context: ReadContext, cursor?: string, limit?: number, selection?: ReportSelection): Promise<Page<ReportView>>;
export declare function listCatalogueReports(dependencies: ReportDependencies, context: ReadContext, cursor?: string, limit?: number, selection?: ReportSelection): Promise<Readonly<{
    entries: readonly Readonly<{
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
    }>[];
    nextCursor: string | null;
    anchor: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>;
}>>;
export {};
