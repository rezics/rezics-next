import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Entry } from './entry-model.ts';
export type MalReviewInput = {
    row: number;
    target: string | null;
    skip: boolean;
    replace: boolean;
};
export type MalApplyInput = {
    confirm: true;
    rows: {
        row: number;
        version: string;
        fields: string[];
    }[];
};
export type MalOutcome = {
    row: number;
    status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';
    applied: string[];
    retained: string[];
    reason: string | null;
};
type Binding = {
    subject: string;
    route: number;
    source: string;
    externalId: string;
};
export type MalReview = {
    version: string;
    target: string | null;
    skip: boolean;
    replace: boolean;
    state: string | null;
    current: Pick<Entry, 'state' | 'revision' | 'incarnationId'> | null;
    binding: Binding | null;
    source: {
        release: string;
        epoch: string;
        acceptingType: string;
    } | null;
    conflict: boolean;
    unsupported: string | null;
};
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    routeKey: Uint8Array;
    clock?: KernelClock;
};
/** One source's bounded composition of current Semantic observations and native Library commands. */
export declare function createMalImport(deps: Dependencies): {
    preview: (actor: Actor, xml: string, key: string, deadline: number) => Promise<import("../command/command.ts").CommandOutcome<{
        id: `${string}-${string}-${string}-${string}-${string}`;
    }>>;
    page: (actor: Actor, id: string, after: number, deadline: number) => Promise<{
        id: string;
        canceled: boolean;
        total: number;
        rows: ({
            index: number;
            kind: 'anime' | 'manga';
            title: string;
            identifier: {
                namespace: string;
                source: string;
                value: string;
            };
            status: import("./list-import-mal-parser.ts").MalValue;
            role: string | null;
            score: import("./list-import-mal-parser.ts").MalValue & {
                scale: {
                    min: 1;
                    max: 10;
                    step: 1;
                };
            };
            progress: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            dates: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            notes: import("./list-import-mal-parser.ts").MalValue;
            tags: import("./list-import-mal-parser.ts").MalValue;
            repeats: import("./list-import-mal-parser.ts").MalValue;
            privacy: import("./list-import-mal-parser.ts").MalValue;
            timestamps: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            fields: Record<string, string>;
            retained: {
                field: string;
                reason: string;
            }[];
            target: null;
            binding: Binding | null;
            source: null;
            current: null;
            state: null;
            match: 'unmatched';
            candidates: {
                subjectId: string;
            }[];
            review: MalReview | null;
            outcome: MalOutcome | null;
        } | {
            index: number;
            kind: 'anime' | 'manga';
            title: string;
            identifier: {
                namespace: string;
                source: string;
                value: string;
            };
            status: import("./list-import-mal-parser.ts").MalValue;
            role: string | null;
            score: import("./list-import-mal-parser.ts").MalValue & {
                scale: {
                    min: 1;
                    max: 10;
                    step: 1;
                };
            };
            progress: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            dates: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            notes: import("./list-import-mal-parser.ts").MalValue;
            tags: import("./list-import-mal-parser.ts").MalValue;
            repeats: import("./list-import-mal-parser.ts").MalValue;
            privacy: import("./list-import-mal-parser.ts").MalValue;
            timestamps: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            fields: Record<string, string>;
            retained: {
                field: string;
                reason: string;
            }[];
            target: null;
            binding: null;
            source: null;
            current: null;
            state: null;
            match: 'unavailable';
            candidates: {
                subjectId: string;
            }[];
            review: MalReview | null;
            outcome: MalOutcome | null;
        } | {
            index: number;
            kind: 'anime' | 'manga';
            title: string;
            identifier: {
                namespace: string;
                source: string;
                value: string;
            };
            status: import("./list-import-mal-parser.ts").MalValue;
            role: string | null;
            score: import("./list-import-mal-parser.ts").MalValue & {
                scale: {
                    min: 1;
                    max: 10;
                    step: 1;
                };
            };
            progress: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            dates: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            notes: import("./list-import-mal-parser.ts").MalValue;
            tags: import("./list-import-mal-parser.ts").MalValue;
            repeats: import("./list-import-mal-parser.ts").MalValue;
            privacy: import("./list-import-mal-parser.ts").MalValue;
            timestamps: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            fields: Record<string, string>;
            retained: {
                field: string;
                reason: string;
            }[];
            target: string;
            binding: Binding | null;
            source: {
                release: string;
                epoch: string;
                acceptingType: string;
            };
            current: {
                state: string;
                revision: number;
                incarnationId: string | null;
            } | null;
            state: string | null;
            match: "already-matched" | "matched";
            candidates: {
                subjectId: string;
            }[];
            review: MalReview | null;
            outcome: MalOutcome | null;
        })[];
        sourcePath: string;
        next: number | null;
        limits: {
            readonly bytes: 2097152;
            readonly wireBytes: 4194304;
            readonly evidenceBytes: 12582912;
            readonly rows: 500;
            readonly page: 20;
            readonly depth: 16;
            readonly uploads: 3;
        };
    }>;
    review: (actor: Actor, id: string, input: MalReviewInput, key: string, deadline: number) => Promise<import("../command/command.ts").CommandOutcome<{
        id: string;
    }>>;
    apply: (actor: Actor, id: string, input: MalApplyInput, deadline: number, signal: AbortSignal, record: (value: Awaited<ReturnType<(actor: Actor, subjectId: string, input: unknown, requestKey: string, guard?: import("./list-import-bangumi-model.ts").BangumiGuard | import("./entries.ts").ReviewedEntrySource | undefined) => Promise<import("../command/command.ts").CommandOutcome<{
        entry: Entry;
        created: boolean;
    }>>>>) => void) => Promise<{
        id: string;
        outcomes: MalOutcome[];
        remaining: number[];
        stopped: boolean;
    }>;
    source: (actor: Actor, id: string, deadline: number) => Promise<{
        xml: string;
    }>;
    cancel: (actor: Actor, id: string, key: string) => Promise<import("../command/command.ts").CommandOutcome<{
        id: string;
    }>>;
    delete: (actor: Actor, id: string, key: string) => Promise<import("../command/command.ts").CommandOutcome<{
        id: string;
    }>>;
};
export type MalPreview = Awaited<ReturnType<ReturnType<typeof createMalImport>['page']>>;
export type MalPreviewRow = MalPreview['rows'][number];
export {};
