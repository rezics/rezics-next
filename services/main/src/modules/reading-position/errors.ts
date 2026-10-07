import { WorkReadUnavailable } from '../work/read-session.ts';
import type { ResumePageKey } from '../progress/store.ts';

export class ReadingSeekUnavailable extends WorkReadUnavailable {}
export class ReadingResumeUnavailable extends WorkReadUnavailable {}
export class ReadingResumeContinuation extends WorkReadUnavailable {
  constructor(readonly after: ResumePageKey) { super('No completion is visible in this window; continue the read'); }
}

/** Kernel must index the accepted value with its Structure/revision, apply
 * disclosure before lookahead and return no ordinal over undisclosed items. */
export const REQUIRED_EPISODE_SEEK = 'readCompositionNumberPage(session, { structure, revision, predicate: "https://schema.org/episodeNumber", value: string, after?: string, limit: 1..100 }): { occurrences, nextCursor, sourcePosition, rowsExamined: <=101 }';
