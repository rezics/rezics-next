import { libraryEntryStateWrite } from './entries-read';
import type { LibraryEntryStateWrite } from './entries-read';
import { commonShelfStates, selectableEntry, type ShelfSelectionCandidate } from './shelf-selection';

// These preflight limits mirror the mounted native command. Native admission remains authoritative.
export const bulkStatusTargetLimit = 1_000;
export const bulkStatusCommandByteLimit = 64 * 1024;

export type BulkStatusPreviewRequest = Readonly<{
  action: 'set_status';
  state: LibraryEntryStateWrite;
  selection: Readonly<{
    kind: 'explicit';
    targets: readonly Readonly<{ subjectId: string }>[];
  }>;
}>;

export type BulkStatusPreviewCapture =
  | Readonly<{
      ok: true;
      request: BulkStatusPreviewRequest;
      body: string;
      byteLength: number;
      subjects: readonly string[];
    }>
  | Readonly<{
      ok: false;
      reason:
        | 'empty_selection'
        | 'unsupported_selection'
        | 'status_incompatible'
        | 'too_many_targets'
        | 'command_too_large';
    }>;

/** Capture the explicit loaded subjects and status that the native preview will persist. */
export function captureBulkStatusPreview(
  entries: readonly ShelfSelectionCandidate[],
  requestedState: string,
): BulkStatusPreviewCapture {
  if (!entries.length) return { ok: false, reason: 'empty_selection' };
  if (
    entries.some(
      (entry) => !selectableEntry(entry) || !entry.subject || !entry.subjectId || entry.subject.id !== entry.subjectId,
    )
  )
    return { ok: false, reason: 'unsupported_selection' };

  const state = libraryEntryStateWrite(requestedState);
  const commonStates = commonShelfStates(entries);
  if (!state || !commonStates.some((choice) => choice.id === state))
    return { ok: false, reason: 'status_incompatible' };

  const subjects = [...new Set(entries.map((entry) => entry.subject!.id))];
  if (subjects.length > bulkStatusTargetLimit) return { ok: false, reason: 'too_many_targets' };

  const targets = Object.freeze(subjects.map((subjectId) => Object.freeze({ subjectId })));
  const request: BulkStatusPreviewRequest = Object.freeze({
    action: 'set_status',
    state,
    selection: Object.freeze({ kind: 'explicit', targets }),
  });
  const body = JSON.stringify(request);
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > bulkStatusCommandByteLimit) return { ok: false, reason: 'command_too_large' };

  return Object.freeze({ ok: true, request, body, byteLength, subjects: Object.freeze(subjects) });
}
