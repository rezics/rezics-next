/** Compatibility facade. Planning lives in application/core; this file owns SQL runners and work consumption. */
import { type Bound } from '@rezics/bounds';
import type { PoolClient } from 'pg';
import sessionInsert from './progress-store-session-insert.sql.d.ts';
import sessionRead from './progress-store-session-read.sql.d.ts';
import sessionUpdate from './progress-store-session-update.sql.d.ts';
import sessionPage from './progress-store-session-page.sql.d.ts';
import journalRead from './progress-store-session-journal-read.sql.d.ts';
import journalLock from './progress-store-session-journal-lock.sql.d.ts';
import journalUpdate from './progress-store-session-journal-update.sql.d.ts';
import unitAdd from './progress-store-unit-add.sql.d.ts';
import unitRemove from './progress-store-unit-remove.sql.d.ts';
import unitClear from './progress-commands-clear-units.sql.d.ts';
import unitPage from './progress-store-unit-page.sql.d.ts';
import changeAppend from './progress-store-change-append.sql.d.ts';
import changePage from './progress-store-change-page.sql.d.ts';
import sessionLock from './session-lock.sql.d.ts';
import discoveryPage from './progress-discovery-page.sql.d.ts';
import discoveryGeneration from './progress-discovery-generation-read.sql.d.ts';
import discoveryReleases from './progress-discovery-releases.sql.d.ts';
import { retainSessionOperands, sessionBytesWork } from './core/index.ts';
import { SESSION_LIMITS } from './contract/index.ts';
import type { SessionCommandOriginal, SessionOperationKind, SessionReadInput, SessionReadKind, SessionSqlKind } from './contract/index.ts';
type Client = Pick<PoolClient, 'query'>;
type Query<I, R> = Readonly<{
    sql: string;
    run(client: Client, input: I): Promise<R>;
}>;
type Input<Q> = Q extends Query<infer I, unknown> ? I : never;
export type { SessionSqlKind, SessionOperationKind, SessionReadKind };
export { SESSION_LIMITS, retainSessionOperands, sessionBytesWork };
export type SessionSqlPlan<I, R> = Readonly<{
    kind: SessionSqlKind;
    input: Readonly<I>;
    total: Bound;
    run(client: Client): Promise<R>;
}>;
export type SessionCommandPlan = Readonly<{
    kind: SessionOperationKind;
    original: SessionCommandOriginal;
    total: Bound;
    consumeAttempt(): Promise<void>;
}>;
export type SessionReadPlan = Readonly<{
    kind: SessionReadKind;
    original: SessionReadInput;
    total: Bound;
    run<T>(dispatch: () => Promise<T>): Promise<T>;
}>;
export declare function withSessionCommandPlan<T>(plan: SessionCommandPlan, dispatch: () => Promise<T>): Promise<T>;
export declare function consumeSessionWork<T>(kind: string, total: Bound, dispatch: () => Promise<T>): Promise<T>;
export declare const sessionInsertPlan: (input: Input<typeof sessionInsert>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        session_id: string;
        account_id: string;
        subject_id: string;
        version_subject_id?: string | null;
        mode: "scalar_amount" | "cursor_position" | "completed_units";
        unit: string;
        total?: string | null;
        time: string;
        last_changed_at: string;
        transaction_id: string;
        library_profile_pin?: import("reylo").Json;
        additional_measures: import("reylo").Json;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        route: number;
        id: string;
        accountId: string;
        subjectId: string;
        versionSubjectId: string | null;
        mode: "scalar_amount" | "cursor_position" | "completed_units";
        unit: string;
        total: string | null;
        amount: string | null;
        locator: string | null;
        position: string | null;
        completedUnitCount: number;
        state: "active" | "completed" | "abandoned" | "retired";
        revision: number;
        startedAt: string;
        completedAt: string | null;
        transactionId: string;
        additionalMeasures: import("reylo").Json;
    } | null>;
}>;
export declare const sessionReadPlan: (input: Input<typeof sessionRead>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        session_id: string;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        route: number;
        id: string;
        accountId: string;
        subjectId: string;
        versionSubjectId: string | null;
        mode: "scalar_amount" | "cursor_position" | "completed_units";
        unit: string;
        total: string | null;
        amount: string | null;
        locator: string | null;
        position: string | null;
        completedUnitCount: number;
        state: "active" | "completed" | "abandoned" | "retired";
        revision: number;
        startedAt: string;
        completedAt: string | null;
        transactionId: string;
        libraryProfilePin: import("reylo").Json;
        additionalMeasures: import("reylo").Json;
    } | null>;
}>;
export declare const sessionUpdatePlan: (input: Input<typeof sessionUpdate>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        amount?: string | null;
        locator?: string | null;
        position?: string | null;
        additional_measures: import("reylo").Json;
        completed_unit_count: number;
        state: "active" | "completed" | "abandoned" | "retired";
        completed_at?: string | null;
        time: string;
        transaction_id: string;
        route: number;
        session_id: string;
        revision: number;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        route: number;
        id: string;
        accountId: string;
        subjectId: string;
        versionSubjectId: string | null;
        mode: "scalar_amount" | "cursor_position" | "completed_units";
        unit: string;
        total: string | null;
        amount: string | null;
        locator: string | null;
        position: string | null;
        completedUnitCount: number;
        state: "active" | "completed" | "abandoned" | "retired";
        revision: number;
        startedAt: string;
        completedAt: string | null;
        transactionId: string;
        additionalMeasures: import("reylo").Json;
    } | null>;
}>;
export declare const sessionLockPlan: (input: Input<typeof sessionLock>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        session_id: string;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        session_id: string;
    } | null>;
}>;
export declare const sessionJournalReadPlan: (input: Input<typeof journalRead>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        account_id: string;
        session_id: string;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        sessionId: string;
        revision: number;
        startYear: number | null;
        startMonth: number | null;
        startDay: number | null;
        finishYear: number | null;
        finishMonth: number | null;
        finishDay: number | null;
        reflection: string | null;
        assessmentUnits: number | null;
        assessmentPresence: string | null;
        assessmentMeaningRevision: number;
    } | null>;
}>;
export declare const sessionJournalLockPlan: (input: Input<typeof journalLock>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        account_id: string;
        session_id: string;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        sessionId: string;
        accountId: string;
        revision: number;
        startYear: number | null;
        startMonth: number | null;
        startDay: number | null;
        finishYear: number | null;
        finishMonth: number | null;
        finishDay: number | null;
        reflection: string | null;
        assessmentUnits: number | null;
        assessmentPresence: string | null;
        assessmentMeaningRevision: number;
    } | null>;
}>;
export declare const sessionJournalUpdatePlan: (input: Input<typeof journalUpdate>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        start_year?: number | null;
        start_month?: number | null;
        start_day?: number | null;
        finish_year?: number | null;
        finish_month?: number | null;
        finish_day?: number | null;
        reflection?: string | null;
        assessment_units?: number | null;
        assessment_presence?: string | null;
        assessment_meaning_revision: number;
        route: number;
        account_id: string;
        session_id: string;
        revision: number;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        sessionId: string;
        revision: number;
        startYear: number | null;
        startMonth: number | null;
        startDay: number | null;
        finishYear: number | null;
        finishMonth: number | null;
        finishDay: number | null;
        reflection: string | null;
        assessmentPresence: string | null;
        assessmentUnits: number | null;
        assessmentMeaningRevision: number;
    } | null>;
}>;
export declare function sessionUnitAddPlan(input: Input<typeof unitAdd>): Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        session_id: string;
        time: string;
        unit_ids: string[];
    }>;
    total: Bound;
    run(client: Client): Promise<{
        added: number;
    }>;
}>;
export declare function sessionUnitRemovePlan(input: Input<typeof unitRemove>): Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        session_id: string;
        unit_ids: string[];
    }>;
    total: Bound;
    run(client: Client): Promise<{
        removed: number;
    }>;
}>;
export declare function sessionUnitClearPlan(input: Input<typeof unitClear>): Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        session_id: string;
    }>;
    total: Bound;
    run(client: Client): Promise<void>;
}>;
export declare const sessionChangeAppendPlan: (input: Input<typeof changeAppend>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        session_id: string;
        change_no: number;
        intent: import("reylo").Json;
        time: string;
        transaction_id: string;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        route: number;
        sessionId: string;
        changeNo: number;
        intent: import("reylo").Json;
        recordedAt: string;
        transactionId: string;
    }>;
}>;
export declare function sessionSubjectPagePlan(input: Input<typeof sessionPage>): Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        account_id: string;
        subject_id: string;
        after_started_at: string;
        after_session_id: string;
        has_cursor: boolean;
        limit: number;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        route: number;
        id: string;
        accountId: string;
        subjectId: string;
        versionSubjectId: string | null;
        libraryProfilePin: import("reylo").Json;
        mode: string;
        unit: string;
        total: string | null;
        amount: string | null;
        additionalMeasures: import("reylo").Json;
        locator: string | null;
        position: string | null;
        completedUnitCount: number;
        state: string;
        revision: number;
        startedAt: string;
        completedAt: string | null;
        transactionId: string;
    }[]>;
}>;
export declare const sessionUnitPagePlan: (input: Input<typeof unitPage>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        session_id: string;
        after_unit_id: string;
        has_cursor: boolean;
        limit: number;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        route: number;
        sessionId: string;
        unitId: string;
        addedAt: string;
    }[]>;
}>;
export declare const sessionChangePagePlan: (input: Input<typeof changePage>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        session_id: string;
        after_change_no: number;
        has_cursor: boolean;
        limit: number;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        route: number;
        sessionId: string;
        changeNo: number;
        intent: import("reylo").Json;
        recordedAt: string;
        transactionId: string;
    }[]>;
}>;
export declare const sessionDiscoveryGenerationPlan: (input: Input<typeof discoveryGeneration>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        account_id: string;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        generation: string;
    }>;
}>;
export declare function sessionDiscoveryPagePlan(input: Input<typeof discoveryPage>): Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        account_id: string;
        subject_id?: string | null;
        filter_kind: string;
        state_filter: string;
        mode_filter: string;
        profile_filter: string;
        after_started_at?: string | null;
        after_session_id?: string | null;
        has_cursor: boolean;
        limit: number;
    }>;
    total: Bound;
    run(client: Client): Promise<{
        route: number;
        id: string;
        accountId: string;
        subjectId: string;
        versionSubjectId: string | null;
        libraryProfilePin: import("reylo").Json;
        mode: "scalar_amount" | "cursor_position" | "completed_units";
        unit: string;
        total: string | null;
        amount: string | null;
        additionalMeasures: import("reylo").Json;
        locator: string | null;
        position: string | null;
        completedUnitCount: number;
        state: "active" | "completed" | "abandoned" | "retired";
        revision: number;
        startedAt: string;
        completedAt: string | null;
        transactionId: string;
    }[]>;
}>;
export declare const sessionDiscoveryReleasesPlan: (input: Input<typeof discoveryReleases>) => Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        digests: string[];
    }>;
    total: Bound;
    run(client: Client): Promise<{
        digest: string;
        body: import("reylo").Json;
    }[]>;
}>;
type MeaningInput = {
    route: number;
    sessionId: string;
    pin: string;
    meanings: string;
};
export declare function sessionMeaningInsertPlan(input: MeaningInput, count: number): Readonly<{
    kind: SessionSqlKind;
    input: Readonly<MeaningInput>;
    total: Bound;
    run(client: Client): Promise<import("pg").QueryResult<any>>;
}>;
export declare function sessionMeaningRefreshPlan(input: {
    route: number;
    sessionId: string;
}): Readonly<{
    kind: SessionSqlKind;
    input: Readonly<{
        route: number;
        sessionId: string;
    }>;
    total: Bound;
    run(client: Client): Promise<import("pg").QueryResult<any>>;
}>;
export declare function sessionPresentationWork(measures: number, sessions?: number): Bound;
export declare function sessionCoreCommandAttemptWork(kind: string, accountId: string, receiptKeys: number, response: object): Bound;
export declare function sessionCommandPlan(kind: SessionOperationKind, original: SessionCommandOriginal, receiptKeys: number, preparesSource?: boolean, durationMs?: number): SessionCommandPlan;
export declare function sessionSnapshotWork(accountId: string): Bound;
export declare function sessionPartitionWork(partition: number): Bound;
export declare function sessionReleaseWork(digest: string, active?: boolean): Bound;
export declare function sessionSourceWork(subjectId: string, withProfile: boolean): Bound;
export declare function sessionHeadWork(input: {
    route: number;
    account_id: string;
    subject_id: string;
}): Bound;
export declare function sessionActivityWork(input: {
    route: number;
    account_id: string;
    subject_id: string;
    time: string;
    completed: boolean;
}): Bound;
export declare function sessionShelfWork(route: number, accountId: string, counters: boolean): Bound;
export declare function sessionProfileMigrationWork(route: number, accountId: string): Bound;
export declare function sessionReadTimeWork(): Bound;
export declare function sessionReadOperationPlan(kind: SessionReadKind, accountId: string, input: SessionReadInput): SessionReadPlan;
