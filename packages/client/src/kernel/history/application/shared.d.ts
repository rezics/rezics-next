import { type HistoryComposition } from '../contract/index.ts';
/** Shared history admission and the native Work module. Each facade delegates to the installed native composition; adapters implement them. */
export declare const admitSharedHistory: HistoryComposition['admitSharedHistory'];
export declare const advanceSharedHistory: HistoryComposition['advanceSharedHistory'];
export declare const redriveSharedHistory: HistoryComposition['redriveSharedHistory'];
export declare const sharedHistoryWorkModule: HistoryComposition['sharedHistoryWorkModule'];
export declare const advanceSelectedHistoryOriginal: HistoryComposition['advanceSelectedHistoryOriginal'];
export declare const advanceOutstandingRecordHistory: HistoryComposition['advanceOutstandingRecordHistory'];
export declare const localSharedHistoryWorkModule: HistoryComposition['localSharedHistoryWorkModule'];
