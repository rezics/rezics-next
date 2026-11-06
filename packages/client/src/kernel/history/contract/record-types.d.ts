export type SharedHistoryResult = Readonly<{
    state: 'more' | 'pending' | 'complete';
    gap: string | null;
}>;
export type RecordHistoryPurgeResult = Readonly<{
    state: 'pending' | 'progress' | 'complete';
    examined: number;
    minimized: number;
}>;
