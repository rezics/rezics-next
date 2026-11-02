import type { PersonalLibraryEntry } from './entries-read';
import { matchesShelfLabelIntent, type ShelfLabelIntent, type ShelfLabelOutcome } from './shelf-selection';
import type { LabelAssignment, LibraryLabelSummary } from './subject-labels.ts';

export type ShelfLabelKind = 'assign' | 'unassign';
export type ShelfLabelResult = Pick<ShelfLabelOutcome, 'status' | 'reason'>;
export type ShelfLabelRequest = {
  id: string;
  kind: ShelfLabelKind;
  label: Pick<LibraryLabelSummary, 'id' | 'name'>;
  targets: { entry: ShelfLabelIntent['entry']; title: string }[];
};
export type ShelfAssignmentRead =
  | { ok: true; assignment: LabelAssignment | null }
  | { ok: false; reason: 'closed' | 'signed-out' | 'unavailable' };

/** Copy identity values before any await; later selections and refreshed rows cannot retarget this request. */
export function captureShelfLabelEntry(entry: PersonalLibraryEntry): ShelfLabelIntent['entry'] {
  return {
    subjectId: entry.subjectId,
    revision: entry.revision,
    changeKey: entry.changeKey,
    removeKey: entry.removeKey,
    ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
  };
}

/** Uses the shelf's shared mutation lease. A failed/uncertain item leaves all following targets unsent. */
export async function executeShelfLabelRequest(
  request: ShelfLabelRequest,
  controls: {
    isCurrent: () => boolean;
    entry: (subjectId: string) => PersonalLibraryEntry | undefined;
    readAssignment: (subjectId: string, labelId: string) => Promise<ShelfAssignmentRead>;
    mutate: (intent: ShelfLabelIntent) => Promise<ShelfLabelResult>;
    record: (subjectId: string, result: ShelfLabelResult) => void;
  },
): Promise<void> {
  for (const target of request.targets) {
    if (!controls.isCurrent()) return;
    const input = {
      intent: 'assign' as const,
      subjectId: target.entry.subjectId,
      labelId: request.label.id,
      idempotencyKey: crypto.randomUUID(),
    };
    const intent: ShelfLabelIntent = {
      input,
      entry: target.entry,
      operationId: request.id,
      labelName: request.label.name,
    };
    const matches = () => {
      const entry = controls.entry(target.entry.subjectId);
      return !!entry && matchesShelfLabelIntent(entry, intent);
    };
    let result: ShelfLabelResult;
    if (!matches()) result = { status: 'conflicted' };
    else {
      if (request.kind === 'unassign') {
        const read = await controls.readAssignment(input.subjectId, input.labelId);
        if (!controls.isCurrent()) return;
        if (!matches()) result = { status: 'conflicted' };
        else if (!read.ok) result = { status: 'failed', reason: read.reason };
        else if (!read.assignment) result = { status: 'unchanged' };
        else {
          intent.input = {
            ...input,
            intent: 'unassign',
            assignmentId: read.assignment.id,
            revision: read.assignment.revision,
          };
          result = await controls.mutate(intent);
        }
      } else result = await controls.mutate(intent);
    }
    if (!controls.isCurrent()) return;
    controls.record(input.subjectId, result);
    if (!['assigned', 'removed', 'unchanged'].includes(result.status)) return;
  }
}
