import type { ProgressMode, ProgressState, ProgressUnit } from './progress.ts';
export type { ProgressIntent, ProgressMode, ProgressState, ProgressUnit } from './progress.ts';
/** One account's reading or viewing session, as stored. `id` is the session id. */
export type ProgressSessionRow = {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
    versionSubjectId: string | null;
    mode: string;
    unit: string;
    total: string | null;
    amount: string | null;
    locator: string | null;
    position: string | null;
    completedUnitCount: number;
    state: string;
    revision: number;
    startedAt: string;
    completedAt: string | null;
    transactionId: string;
};
/** Private view of one progress session. Value and state change only through a revision compare-and-swap. */
export type ProgressSession = Omit<ProgressSessionRow, 'route' | 'mode' | 'unit' | 'state'> & {
    mode: ProgressMode;
    unit: ProgressUnit;
    state: ProgressState;
};
export type ProgressSessionDraft = {
    id: string;
    accountId: string;
    subjectId: string;
    versionSubjectId: string | null;
    mode: ProgressMode;
    unit: ProgressUnit;
    total: string | null;
};
/** The next mode value and state. Columns that belong to another mode stay null, and the unit count stays 0. */
export type ProgressSessionUpdate = {
    amount: string | null;
    locator: string | null;
    position: string | null;
    completedUnitCount: number;
    state: ProgressState;
    completedAt: string | null;
};
export type ProgressSessionPage = {
    after: {
        startedAt: string;
        sessionId: string;
    } | null;
    limit: number;
};
/** One opaque id in a session's sparse completed-unit set. */
export type ProgressUnitRow = {
    route: number;
    sessionId: string;
    unitId: string;
    addedAt: string;
};
export type ProgressUnitRecord = Omit<ProgressUnitRow, 'route'>;
export type ProgressUnitPage = {
    after: {
        unitId: string;
    } | null;
    limit: number;
};
/** One recorded intent. `intent` is the JSON value as given, not a derived range. */
export type ProgressChangeRow = {
    route: number;
    sessionId: string;
    changeNo: number;
    intent: unknown;
    recordedAt: string;
    transactionId: string;
};
export type ProgressChange = Omit<ProgressChangeRow, 'route'>;
export type ProgressChangePage = {
    after: {
        changeNo: number;
    } | null;
    limit: number;
};
export declare const MAX_PROGRESS_PAGE_SIZE = 100;
export declare const MAX_PROGRESS_UNIT_IDS = 100;
