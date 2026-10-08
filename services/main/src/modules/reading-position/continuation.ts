import { NATIVE_ID } from '../structure/graph.ts';
import type { ResumePageKey } from '../progress/store.ts';
import { WorkReadInvalid } from '../work/read-session.ts';

/** Internal checkpoints are carried only inside the route's encrypted cursor;
 * hidden occurrence IDs never become public item or continuation fields. */
export type ReadingContinuation =
  | { version: 1; kind: 'browse'; occurrence: string; descend: boolean; withheld?: true }
  | { version: 1; kind: 'resume'; after: ResumePageKey }
  | { version: 1; kind: 'search'; browse: string | null; resume: ResumePageKey | null };
/** `withheld` marks a position reached after this read stepped over an
 * undisclosed placement. Later pages cannot know how many earlier siblings were
 * hidden, so they never return a physical ordinal. */
export const browseContinuation = (occurrence: string, descend: boolean, withheld = false) =>
  JSON.stringify({ version: 1, kind: 'browse', occurrence, descend,
    ...(withheld ? { withheld: true } : {}) } satisfies ReadingContinuation);
export const resumeContinuation = (after: ResumePageKey) =>
  JSON.stringify({ version: 1, kind: 'resume', after } satisfies ReadingContinuation);
export const searchContinuation = (browse: string | null, resume: ResumePageKey | null) =>
  JSON.stringify({ version: 1, kind: 'search', browse, resume } satisfies ReadingContinuation);
function validResume(key: ResumePageKey) {
  return !!key && NATIVE_ID.test(key.occurrence) && (key.selectedRevision === null
    || /^urn:rezics:content:revision:[0-9a-f-]{36}$/.test(key.selectedRevision))
    && (key.structure === undefined || NATIVE_ID.test(key.structure))
    && (key.seriesOccurrence === undefined || NATIVE_ID.test(key.seriesOccurrence));
}
export function readingContinuation(value: string, kind?: ReadingContinuation['kind']): ReadingContinuation {
  let cursor: ReadingContinuation;
  try { cursor = JSON.parse(value) as ReadingContinuation; }
  catch { throw new WorkReadInvalid('Reading continuation is invalid'); }
  if (!cursor || cursor.version !== 1 || kind && cursor.kind !== kind
    || !['browse', 'resume', 'search'].includes(cursor.kind)
    || cursor.kind === 'browse' && (!NATIVE_ID.test(cursor.occurrence) || typeof cursor.descend !== 'boolean'
      || !(cursor.withheld === undefined || cursor.withheld === true))
    || cursor.kind === 'resume' && !validResume(cursor.after)
    || cursor.kind === 'search' && (!(cursor.resume === null || validResume(cursor.resume))
      || !(cursor.browse === null || typeof cursor.browse === 'string'))) {
    throw new WorkReadInvalid('Reading continuation is invalid');
  }
  return cursor;
}
