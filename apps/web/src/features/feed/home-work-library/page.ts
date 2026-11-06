import type { SubjectSlotEntry } from '../../../library/subject-slot';
import type { FeedPage } from '../../pages/home-feed-read';
import type { SubjectOwnRating } from '../../pages/subject-ratings';
import type {
  HomeWorkLibraryFact,
  HomeWorkLibraryLease,
  HomeWorkLibraryPage,
  HomeWorkLibraryProjection,
  HomeWorkLibraryRow,
  HomeWorkLibraryScope,
} from './contract';

/** The installed page's personal facts: one bounded native reading per authenticated Home response. */
export type HomeNativePersonalPage = NonNullable<FeedPage['viewerPersonalActions']>;
type NativeCurrentPage = Extract<HomeNativePersonalPage, { state: 'current' }>;
type NativeRow = NativeCurrentPage['rows'][number];

/** Only the standard counted question (scale 0–20, step 1) can supply the Home score. */
const STANDARD_QUESTION_ID = '00000000-0000-7000-8000-000000000001';

function entryFact(entry: NativeRow['entry'], subjectId: string): HomeWorkLibraryFact<SubjectSlotEntry> {
  if (entry.state === 'absent') return { state: 'absent' };
  if (entry.state !== 'present' || entry.entryState === null) return { state: 'unavailable' };
  return {
    state: 'present',
    value: { subjectId, state: entry.entryState, revision: entry.revision, incarnationId: entry.incarnationId },
  };
}

function scoreFact(
  vote: NativeRow['vote'],
  question: NativeCurrentPage['question'],
  reader: string,
): HomeWorkLibraryFact<SubjectOwnRating> {
  if (
    question === null ||
    question.id !== STANDARD_QUESTION_ID ||
    question.revision !== 1 ||
    question.scale.min !== 0 ||
    question.scale.max !== 20 ||
    question.scale.displayStep !== 1 ||
    vote.state === 'unavailable' ||
    vote.questionId !== question.id ||
    vote.questionRevision !== question.revision
  )
    return { state: 'unavailable' };
  if (vote.state === 'absent') return { state: 'absent' };
  return { state: 'present', value: { reader, kind: 'ready', units: vote.units } };
}

function actionsFact(actions: NativeRow['actions']): HomeWorkLibraryRow['actions'] {
  return actions.state === 'current' ? { state: 'current', allowed: actions.allowed } : { state: 'unavailable' };
}

/** Original occurrence keys and Subjects are kept as delivered: no join, dedupe, reindex or refill. */
export function homeWorkLibraryPage(native: HomeNativePersonalPage, reader: string): HomeWorkLibraryPage {
  if (native.state !== 'current') return { state: 'unavailable', rows: [] };
  return {
    state: 'ready',
    rows: native.rows.map((row) => ({
      rowKey: row.rowKey,
      subjectId: row.subjectId,
      entry: entryFact(row.entry, row.subjectId),
      score: scoreFact(row.vote, native.question, reader),
      actions: actionsFact(row.actions),
    })),
  };
}

/** The page's source lifetime is the feed window snapshot that delivered it; the caller supplies that lease. */
export function homeWorkLibraryFeedProjection(input: {
  native: HomeNativePersonalPage;
  scope: HomeWorkLibraryScope;
  lease: HomeWorkLibraryLease;
}): HomeWorkLibraryProjection {
  return { scope: input.scope, page: homeWorkLibraryPage(input.native, input.scope.reader), lease: input.lease };
}
