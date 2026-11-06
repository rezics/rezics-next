import { historyComposition } from './composition.ts';
import { type HistoryComposition } from '../contract/index.ts';
/** Shared history admission and the native Work module. Each facade delegates to the installed native composition; adapters implement them. */

export const admitSharedHistory: HistoryComposition['admitSharedHistory'] = (...args) =>
  historyComposition().admitSharedHistory(...args);

export const advanceSharedHistory: HistoryComposition['advanceSharedHistory'] = (...args) =>
  historyComposition().advanceSharedHistory(...args);

export const redriveSharedHistory: HistoryComposition['redriveSharedHistory'] = (...args) =>
  historyComposition().redriveSharedHistory(...args);

export const sharedHistoryWorkModule: HistoryComposition['sharedHistoryWorkModule'] = {
  get name() {
    return historyComposition().sharedHistoryWorkModule.name;
  },
  register: (context) => historyComposition().sharedHistoryWorkModule.register(context),
};

export const advanceSelectedHistoryOriginal: HistoryComposition['advanceSelectedHistoryOriginal'] = (...args) =>
  historyComposition().advanceSelectedHistoryOriginal(...args);

export const advanceOutstandingRecordHistory: HistoryComposition['advanceOutstandingRecordHistory'] = (...args) =>
  historyComposition().advanceOutstandingRecordHistory(...args);

export const localSharedHistoryWorkModule: HistoryComposition['localSharedHistoryWorkModule'] = {
  get name() {
    return historyComposition().localSharedHistoryWorkModule.name;
  },
  register: (context) => historyComposition().localSharedHistoryWorkModule.register(context),
};
