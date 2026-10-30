import type { FakeRoute } from '../fake-modules.ts';
import type { KernelRecording } from '../fake.ts';
import { recordedBookState } from './library-entry-states.ts';

const outcomes: Record<string, string> = {
  'book-one': 'ok',
  '01a17a3b-0884-721b-91ef-d7ffd7bb58e4': 'ok',
  '01a17a3b-6b89-748f-a486-33c354ef3c9a': 'ok',
  '01a17ff1-d687-75b6-ac1f-86c0da7a09ef': 'ok',
  '01a17a3b-6bd9-706f-b395-987536454933': 'occupied',
  '01a17a3b-6bc3-764f-8727-7872d197bd93': 'stale',
  '01a17a3b-6bab-705b-935e-d6dc0cacd82d': 'expired',
};
let subjectOutcome: 'ok' | 'occupied' | 'stale' | 'expired' = 'ok';
/** Failure injection for subject page stories; each preview has its own module instance. */
export function selectEntryUndoOutcome(outcome: typeof subjectOutcome = 'ok'): void {
  subjectOutcome = outcome;
}

function known(subjectId: string): boolean {
  return Object.hasOwn(outcomes, subjectId);
}
function currentEntry(subjectId: string, recordings: Record<string, KernelRecording>) {
  const entries = ['library-entries', 'library-continue-entries'].flatMap(
    (name) =>
      (recordings[name]?.libraryEntries as { subjectId: string; state?: string; subject?: unknown }[] | undefined) ??
      [],
  );
  const recorded = entries.find((entry) => entry.subjectId === subjectId);
  return {
    subjectId,
    ...(recordedBookState(0) ? { state: recordedBookState(0) } : recorded?.state ? { state: recorded.state } : {}),
    revision: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    subject:
      entries?.find((entry) => entry.subjectId === subjectId)?.subject ??
      (subjectId === 'book-one' ? { id: subjectId, type: 'book', label: 'A book' } : null),
  };
}
const remove: FakeRoute['story'] = ({ match }) => {
  const id = decodeURIComponent(match![1]!);
  if (!known(id)) return;
  const outcome = outcomes[id] === 'ok' ? subjectOutcome : outcomes[id];
  return {
    status: 204,
    headers: { 'Library-Entry-Deletion-Id': `undo-${outcome}`, 'Library-Entry-Deletion-Revision': '12' },
  };
};
const read: FakeRoute['story'] = ({ match, recordings }) => {
  const id = decodeURIComponent(match![1]!);
  if (!known(id)) return;
  return {
    status: 200,
    libraryEntry: { ...currentEntry(id, recordings), state: recordedBookState(2), revision: 15 },
  };
};
const restore: FakeRoute['story'] = async ({ request, match, recordings }) => {
  const id = decodeURIComponent(match![1]!);
  if (!known(id)) return;
  const { deletionId, revision } = (await request.json()) as { deletionId: string; revision: number };
  if (revision !== 12 || !/^undo-(ok|occupied|stale|expired)$/.test(deletionId))
    return { status: 409, code: 'library_entry_restore_stale' };
  const reason = deletionId.slice(5);
  return reason !== 'ok'
    ? { status: 409, code: `library_entry_restore_${reason}`, title: `library_entry_restore_${reason}` }
    : { status: 200, libraryEntry: { ...currentEntry(id, recordings), revision: 7 } };
};
// Auto-discovered by fake-modules.ts; no recorded response or earlier module registration changes.
export const routes: FakeRoute[] = [
  { method: 'DELETE', path: /^\/v1\/libraryEntries\/([^/]+)$/, story: remove, fixture: remove },
  { method: 'GET', path: /^\/v1\/libraryEntries\/([^/]+)$/, story: read, fixture: read },
  { method: 'POST', path: /^\/v1\/libraryEntries\/([^/]+):restore$/, story: restore, fixture: restore },
];
