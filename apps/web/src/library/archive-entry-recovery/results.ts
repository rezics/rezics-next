import type { NativeArchiveResults } from './native';
import type { ArchiveReviewItem } from './native';
import {
  ownRecoveryPage,
  recoveryPageLimit,
  recoverySelectionLimit,
  type RecoveryChoice,
  type RecoverySection,
} from './selection';

type NativeResult = NativeArchiveResults['results'][number];
type ResultContext = Omit<NativeArchiveResults, 'results'>;
type SelectedResult = Pick<NativeResult, 'ordinal' | 'section' | 'status'> & {
  subjectId: string | null;
  labelId?: string;
  sessionId?: string;
  provider?: string;
  recordId?: string;
};

const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supported = new Set<RecoverySection>([
  'entries',
  'labels',
  'assignments',
  'annotations',
  'journals',
  'provenance',
]);

/** Only a checkpointed native receipt may supply a successful canonical destination. */
function destination(row: NativeResult): string | null {
  if (row.status !== 'acknowledged' || row.result === null) return null;
  const expected = row.section === 'entries' ? 'entry.put' : row.section === 'assignments' ? 'label.assign' : null;
  if (expected === null || row.result.effect !== expected) return null;
  const id = row.result.subjectId;
  return typeof id === 'string' && subjectId.test(id) ? id : null;
}

/**
 * Project one supplied native page, in supplied order, for the original confirmed selection.
 * Never retain arbitrary result JSON: an unresolved response may contain a progressSession or
 * completedEpisodes before the native receipt has been checkpointed. Neither is recovery here.
 * This projection grants no permission to release the original recoverable command.
 */
export function selectedArchiveRecoveryResults(
  page: NativeArchiveResults,
  selection: readonly Pick<RecoveryChoice<ArchiveReviewItem>, 'ordinal' | 'section' | 'choice'>[],
) {
  if (page.results.length > recoveryPageLimit) throw new Error('page_limit');
  if (selection.length > recoverySelectionLimit) throw new Error('selection_limit');
  const selected = new Map<number, Pick<RecoveryChoice<ArchiveReviewItem>, 'section' | 'choice'>>();
  for (const choice of selection) {
    if (
      !Number.isSafeInteger(choice.ordinal) ||
      choice.ordinal < 0 ||
      selected.has(choice.ordinal) ||
      !supported.has(choice.section)
    )
      throw new Error('invalid_selection');
    selected.set(choice.ordinal, choice);
  }
  const rows: SelectedResult[] = [];
  for (const row of page.results) {
    const selectedChoice = selected.get(row.ordinal);
    if (selectedChoice?.section !== row.section) continue;
    const reviewChoice = selectedChoice.choice;
    const labelId =
      row.status === 'acknowledged' &&
      row.section === 'labels' &&
      row.result?.effect === 'label.create' &&
      typeof row.result.labelId === 'string'
        ? row.result.labelId
        : undefined;
    let currentSubjectId = destination(row);
    let sessionId: string | undefined;
    if (row.status === 'acknowledged' && row.result !== null) {
      switch (reviewChoice.kind) {
        case 'entry':
        case 'assignment':
          break;
        case 'label':
          break;
        case 'annotation':
          currentSubjectId = reviewChoice.subjectId;
          break;
        case 'journal':
          currentSubjectId = reviewChoice.subjectId;
          sessionId = reviewChoice.sessionId;
          break;
      }
    }
    rows.push({
      ordinal: row.ordinal,
      section: row.section,
      status: row.status,
      subjectId: currentSubjectId,
      ...(labelId === undefined ? {} : { labelId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }
  const context: ResultContext = { uploadId: page.uploadId, state: page.state, next: page.next };
  return ownRecoveryPage({ rows, context });
}
