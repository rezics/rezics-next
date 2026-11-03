import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { getLocale } from '../paraglide/runtime.js';
import type { BulkOperation } from '../library/bulk-operation-recovery-native';
import type { BulkUndoOutcome } from '../library/bulk-operation-undo-evidence';
import { BulkOperationUndoView } from '../library/bulk-operation-undo-view';
import type { UndoAttempt, UndoState } from '../library/bulk-operation-undo';
import type { LibraryRestoreResult, ReloadedLibraryEntry } from '../library/entries-read';

const meta = {
  title: 'Pages/Library/Bulk Operation Undo',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const operationId = '01b5b3de-6ad2-7fc8-a604-e058df922001';
const fixtureCsrf = 'constructed-story-csrf';
const receipt = { deletionId: 'fixture-deletion-one', revision: 12, restoreUntil: '2099-11-04T00:00:00.000Z' };

function operation(action: BulkOperation['action'] = 'remove_from_library', targets = 1): BulkOperation {
  return {
    id: operationId,
    route: 1,
    action,
    state: null,
    collectionId: null,
    selectionKind: 'explicit',
    phase: 'completed',
    selectionComplete: true,
    occurrencesComplete: true,
    cancelRequested: false,
    counts: {
      scannedCandidates: targets,
      selectedSubjects: targets,
      scannedOccurrences: 0,
      capturedOccurrences: 0,
      targets,
      pending: 0,
      reconciling: 0,
      applied: targets,
      no_effect: 0,
      conflict: 0,
      denied: 0,
      failed: 0,
      cancelled: 0,
    },
    summary: null,
    admittedAt: '2026-11-03T01:00:00.000Z',
    targetBoundAt: null,
    expiresAt: '2026-11-04T01:00:00.000Z',
    resultsExpireAt: '2026-11-05T01:00:00.000Z',
    finishedAt: '2026-11-03T02:00:00.000Z',
    reason: null,
  };
}

function outcome(
  ordinal: string,
  subjectId: string,
  deletion: BulkUndoOutcome['deletion'] = receipt,
): BulkUndoOutcome {
  return {
    ordinal,
    subjectId,
    memberId: null,
    resultingMemberId: null,
    state: 'applied',
    reason: null,
    deletion,
    memberDeletion: null,
  };
}

function readyState({
  action = 'remove_from_library',
  outcomes,
}: {
  action?: BulkOperation['action'];
  outcomes: BulkUndoOutcome[];
}): UndoState {
  return { read: 'ready', operation: operation(action, outcomes.length), page: { outcomes, next: null } };
}

function attempt(status: UndoAttempt['status'], result?: LibraryRestoreResult): UndoAttempt {
  return {
    status,
    command: {
      subjectId: 'fixture-book-one',
      ...receipt,
      idempotencyKey: '01b5b3de-6ad2-7fc8-a604-e058df922003',
      credential: 'constructed-original-credential',
    },
    headers: new Headers({ 'X-CSRF-Token': fixtureCsrf }),
    send: async () => ({ ok: false, reason: 'unavailable' }),
    ...(result ? { result } : {}),
  };
}

function fixture({
  label,
  state,
  attempts = new Map<string, UndoAttempt>(),
  authorized = true,
  writeAvailable = true,
}: {
  label: string;
  state?: UndoState;
  attempts?: ReadonlyMap<string, UndoAttempt>;
  authorized?: boolean;
  writeAvailable?: boolean;
}): Story {
  return {
    name: `Constructed fixture / ${label}`,
    parameters: {
      docs: { description: { story: 'Constructed UI fixture; not a native recording or passing interface evidence.' } },
    },
    render: () => (
      <BulkOperationUndoView
        href={`/${getLocale()}/library/operations/${operationId}/undo`}
        authorized={authorized}
        state={state}
        busy={false}
        writeAvailable={writeAvailable}
        csrfToken={fixtureCsrf}
        attempts={attempts}
        locale={getLocale()}
        onRead={fn()}
        onMore={fn()}
        onRestore={fn()}
      />
    ),
  };
}

const restoredEntry: ReloadedLibraryEntry = {
  subjectId: 'fixture-book-one',
  state: 'reading',
  revision: 13,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-03T02:00:00.000Z',
  subject: null,
};

const restored: LibraryRestoreResult = { ok: true, entry: restoredEntry };
const occupied: LibraryRestoreResult = { ok: false, reason: 'occupied' };
const stale: LibraryRestoreResult = { ok: false, reason: 'stale' };

export const OriginalRemovalReceipt = fixture({
  label: 'original removal receipt and restore deadline',
  state: readyState({ outcomes: [outcome('0', 'fixture-book-one')] }),
});

export const Restored = fixture({
  label: 'restored',
  state: readyState({ outcomes: [outcome('0', 'fixture-book-one')] }),
  attempts: new Map([['0', attempt('finished', restored)]]),
});

export const OccupiedConflict = fixture({
  label: 'occupied conflict',
  state: readyState({ outcomes: [outcome('0', 'fixture-book-one')] }),
  attempts: new Map([['0', attempt('finished', occupied)]]),
});

export const StaleAndExpiredReceipt = fixture({
  label: 'stale and expired receipt',
  state: readyState({
    outcomes: [
      outcome('0', 'fixture-expired-book', { ...receipt, restoreUntil: '2000-01-01T00:00:00.000Z' }),
      outcome('1', 'fixture-stale-book'),
    ],
  }),
  attempts: new Map([['1', attempt('finished', stale)]]),
});

export const UncertainSameCommandRetry = fixture({
  label: 'uncertain same-command retry',
  state: readyState({ outcomes: [outcome('0', 'fixture-book-one')] }),
  attempts: new Map([['0', attempt('uncertain')]]),
});

export const WrongOperationAction = fixture({
  label: 'wrong operation action',
  state: readyState({ action: 'set_status', outcomes: [outcome('0', 'fixture-book-one')] }),
});

export const ReadUnavailableRetry = fixture({ label: 'read unavailable and retry', state: { read: 'unavailable' } });

export const RetiredWriteAdmission = fixture({
  label: 'retired write admission',
  state: readyState({ outcomes: [outcome('0', 'fixture-book-one')] }),
  writeAvailable: false,
});
