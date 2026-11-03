import { type CommandOutcome } from '../command/command.ts';
import { type Actor } from '../request/access.ts';
import { createEntryCommands } from './entries.ts';
type Config = Parameters<typeof createEntryCommands>[0] & {
    routeKey: Uint8Array;
};
export type VndbChoice = {
    ordinal: number;
    action: 'skip' | 'retain' | 'state';
    targetId?: string;
    state?: string;
    replace?: boolean;
};
/** Upload-local composition of existing native Library entry commands. No provider fetch or public output. */
export declare function createVndbImport(config: Config): {
    preview: (actor: Actor, xml: string, key: string) => Promise<CommandOutcome<{
        uploadId: `${string}-${string}-${string}-${string}-${string}`;
        rows: number;
        limits: {
            readonly bytes: number;
            readonly wireBytes: number;
            readonly depth: 32;
            readonly rows: 5000;
            readonly evidenceBytes: number;
            readonly page: 8;
            readonly uploads: 4;
            readonly lifetimeMs: 86400000;
            readonly applyMs: 5000;
        };
    }>>;
    page: (actor: Actor, id: string, offset: number) => Promise<{
        uploadId: string;
        state: "active" | "cancelled";
        expiresAt: string;
        total: number;
        next: number | null;
        rows: {
            ordinal: number;
            kind: 'vn' | 'retained';
            identifier: {
                provider: 'vndb';
                kind: 'vn';
                value: string;
            } | null;
            title: string;
            labels: string[];
            suggestedRole: string | null;
            fields: Record<string, import("./list-import-vndb-parser.ts").SourceValue>;
            retainedReason: string;
            evidence: unknown;
            match: {
                status: 'unsupported';
                candidates: string[];
            } | {
                status: "ambiguous" | "matched" | "unavailable" | "unmatched";
                candidates: string[];
            };
            target: {
                targetId: string;
                states: {
                    id: string;
                    labels: import("@rezics/definitions").LibraryLabels;
                    role?: 'planned' | 'active' | 'completed' | 'paused' | 'dropped';
                }[];
                baseline: {
                    state: string;
                    revision: number;
                    incarnationId: string | null;
                } | null;
            } | null;
            decision: {
                reviewId: string;
                status: "applied" | "applying" | "failed" | "reviewed" | "skipped" | "stale" | "unsupported";
                targetId: string | null;
                state: string | null;
                baseline: {
                    state: string;
                    revision: number;
                    incarnationId: string | null;
                } | null;
                replace: boolean;
            } | null;
            fieldsTreatment: {
                state: string;
                other: string;
            };
        }[];
    }>;
    review: (actor: Actor, id: string, choice: VndbChoice, key: string) => Promise<CommandOutcome<{
        reviewId: string;
        status: "applied" | "applying" | "failed" | "reviewed" | "skipped" | "stale" | "unsupported";
        targetId: string | null;
        state: string | null;
        baseline: {
            state: string;
            revision: number;
            incarnationId: string | null;
        } | null;
        replace: boolean;
    }>>;
    apply: (actor: Actor, id: string, selected: {
        ordinal: number;
        reviewId: string;
    }[], record: (outcome: CommandOutcome<unknown>) => void, signal?: AbortSignal) => Promise<{
        uploadId: string;
        outcomes: {
            ordinal: number;
            reviewId: string;
            status: string;
        }[];
        stopped: "cancelled" | "deadline" | null;
    }>;
    remove: (actor: Actor, id: string, key: string, cancel: boolean) => Promise<CommandOutcome<{
        uploadId: string;
        state: string;
    }>>;
    source: (actor: Actor, id: string) => Promise<{
        xml: string;
    }>;
};
export {};
