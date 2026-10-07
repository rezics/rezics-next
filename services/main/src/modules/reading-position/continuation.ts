import { NATIVE_ID } from '../structure/graph.ts';
import type { ResumePageKey } from '../progress/store.ts';
import { WorkReadInvalid } from '../work/read-session.ts';

/** Internal checkpoints are carried only inside the route's encrypted cursor;
 * hidden occurrence IDs never become public item or continuation fields. */
export type ReadingContinuation =
  | { version: 1; kind: 'browse'; occurrence: string; descend: boolean }
  | { version: 1; kind: 'resume'; after: ResumePageKey };
export const browseContinuation = (occurrence: string, descend: boolean) =>
  JSON.stringify({ version: 1, kind: 'browse', occurrence, descend } satisfies ReadingContinuation);
export const resumeContinuation = (after: ResumePageKey) =>
  JSON.stringify({ version: 1, kind: 'resume', after } satisfies ReadingContinuation);
export function readingContinuation(value: string, kind: ReadingContinuation['kind']): ReadingContinuation {
  let cursor: ReadingContinuation;
  try { cursor = JSON.parse(value) as ReadingContinuation; }
  catch { throw new WorkReadInvalid('Reading continuation is invalid'); }
  if (!cursor || cursor.version !== 1 || cursor.kind !== kind
    || cursor.kind === 'browse' && (!NATIVE_ID.test(cursor.occurrence) || typeof cursor.descend !== 'boolean')
    || cursor.kind === 'resume' && (!cursor.after || !NATIVE_ID.test(cursor.after.occurrence)
      || !(cursor.after.selectedRevision === null || /^urn:rezics:content:revision:[0-9a-f-]{36}$/.test(cursor.after.selectedRevision)))) {
    throw new WorkReadInvalid('Reading continuation is invalid');
  }
  return cursor;
}
