export class ContentConflict extends Error {}
export class ContentUnavailable extends Error {}
export class ContentLimitExceeded extends Error {}
/** The write committed; its event waits for the sequencer. Retry with the same operation. */
export class ContentPositionPending extends ContentUnavailable {}
