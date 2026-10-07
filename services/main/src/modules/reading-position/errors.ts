import { WorkReadLimit, WorkReadUnavailable } from '../work/read-session.ts';

export class ReadingSeekUnavailable extends WorkReadUnavailable {}
export class ReadingResumeUnavailable extends WorkReadUnavailable {}
export class ReadingResumeDisclosureBound extends WorkReadLimit {}

/** Kernel must index the accepted value with its Structure/revision, apply
 * disclosure before lookahead and return no ordinal over undisclosed items. */
export const REQUIRED_EPISODE_SEEK = 'readCompositionNumberPage(session, { structure, revision, predicate: "https://schema.org/episodeNumber", value: string, after?: string, limit: 1..100 }): { occurrences, nextCursor, sourcePosition, rowsExamined: <=101 }';
