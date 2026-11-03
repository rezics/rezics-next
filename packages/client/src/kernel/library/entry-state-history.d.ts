export type EntryStateHistoryOptions = { cursor?: string; limit?: number };
export type EntryStateCommandKind = 'library.entry.put' | 'library.entry.state.restore';
export type EntryStateChange = {
    revision: number;
    priorRevision: number | null;
    beforeState: string | null;
    afterState: string;
    commandId: string;
    commandKind: EntryStateCommandKind;
    changedAt: string;
};
export type EntryStateHistoryPage = {
    incarnationId: string | null;
    currentRevision: number;
    changes: EntryStateChange[];
    coverage: 'complete' | 'partial' | 'unknown';
    next: string | null;
};
export type EntryStateChangeReview = {
    change: EntryStateChange;
    current: { incarnationId: string | null; revision: number; state: string };
    availability: 'available' | 'no_prior_state' | 'state_unavailable';
};
export type EntryStateRestoreRequest = { incarnationId: string; currentRevision: number };
