import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { undoToast } from '@rezics/ui/undo-toast';
import { m } from '../paraglide/messages.js';
import { useOperation } from '../kernel/exposure';
import { csrfHeaders } from '../threads/composer';
import {
  deletePersonalLibraryEntry,
  restorePersonalLibraryEntryAction,
  savePersonalLibraryEntry,
} from './entries-actions';
import type { PersonalLibraryEntry } from './entries-read';
import {
  commonShelfStates,
  matchesShelfIntent,
  matchesShelfLabelIntent,
  selectableEntry,
  shelfSelectionLimit,
  shelfStateIntent,
  type ShelfOutcome,
  type ShelfStateIntent,
  type ShelfLabelIntent,
  type ShelfLabelOutcome,
} from './shelf-selection';
import { displayLibraryTitle } from './title';
import { mutateSubjectLabelAction } from './subject-slot-actions';
import type { LibraryLabelSummary } from './subject-labels.ts';

/** The existing synchronous mutation lease survives a page/actor replacement until its request settles. */
export type ShelfMutationLease = { current: boolean; listeners: Set<() => void> };
export const shelfMutationLease = (): ShelfMutationLease => ({ current: false, listeners: new Set() });

export type ShelfFailure = 'closed' | 'denied' | 'unavailable' | 'signed-out' | 'unsupported_library_profile';
/** One entry as the shelf holds it: what the kernel last said, and what happened to the last write. */
export type ShelfRow = {
  entry: PersonalLibraryEntry;
  conflict: boolean;
  failure: ShelfFailure | null;
  unknownIntent?: ShelfStateIntent;
  unknownLabelIntent?: ShelfLabelIntent;
};

function withoutIncarnation(entry: PersonalLibraryEntry): PersonalLibraryEntry {
  const current = { ...entry };
  delete current.incarnationId;
  return current;
}

function failureOf(reason: string): ShelfFailure {
  if (reason === 'closed' || reason === 'denied' || reason === 'signed-out' || reason === 'unsupported_library_profile')
    return reason;
  return 'unavailable';
}

/** True once the page has hydrated; writes need JavaScript, so their controls stay disabled until then. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/**
 * The entries of one shelf, with the writes that change them. A status change keeps the entry where it is and shows
 * its new status; a conflict replaces it with the entry as it now is; a removal drops it. Each write carries the
 * revision, incarnation and idempotency key the entry holds, and takes a fresh key once it has been answered.
 */
export function useShelfRows(initial: PersonalLibraryEntry[], locale: string, busy: ShelfMutationLease) {
  const [rows, setRows] = useState<ShelfRow[]>(() =>
    initial.map((entry) => ({ entry, conflict: false, failure: null })),
  );
  const currentRows = useRef(rows);
  const mounted = useRef(true);
  const queuedUndo = useRef<(() => void) | null>(null);
  const pending = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        busy.listeners.add(listener);
        return () => {
          busy.listeners.delete(listener);
        };
      },
      [busy],
    ),
    () => busy.current,
    () => false,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<ShelfOutcome[]>([]);
  const [labelOutcomes, setLabelOutcomes] = useState<ShelfLabelOutcome[]>([]);
  const [assignedLabelName, setAssignedLabelName] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const restoreAdmitted = useOperation('library_entry.restore');
  const writeAdmitted = useOperation('library_entry.put');
  const authority = useRef(writeAdmitted);
  authority.current = writeAdmitted;
  const labelWriteAdmitted = useOperation('library_label.assign');
  const labelAuthority = useRef(labelWriteAdmitted);
  labelAuthority.current = labelWriteAdmitted;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queuedUndo.current = null;
    };
  }, []);

  // Update the imperative snapshot together with React state, so a sequence never reads a previous render's rows.
  const updateRows = useCallback((change: (current: ShelfRow[]) => ShelfRow[]) => {
    if (!mounted.current) return;
    const next = change(currentRows.current);
    currentRows.current = next;
    setRows(next);
    setSelected((current) =>
      current.filter((id) => next.some((row) => row.entry.subjectId === id && selectableEntry(row.entry))),
    );
  }, []);
  const patch = useCallback(
    (subjectId: string, change: (row: ShelfRow) => ShelfRow | null) =>
      updateRows((current) =>
        current.flatMap((row) => {
          if (row.entry.subjectId !== subjectId) return [row];
          const next = change(row);
          return next ? [next] : [];
        }),
      ),
    [updateRows],
  );
  const lock = () => {
    if (!mounted.current || busy.current) return false;
    busy.current = true;
    busy.listeners.forEach((listener) => listener());
    return true;
  };
  const unlock = () => {
    busy.current = false;
    busy.listeners.forEach((listener) => listener());
    const undo = queuedUndo.current;
    queuedUndo.current = null;
    undo?.();
  };

  /** Shared by single-row changes, selected-page commands and deliberate same-key recovery. */
  const transition = async (intent: ShelfStateIntent): Promise<{ status: ShelfOutcome['status']; stop?: boolean }> => {
    if (!mounted.current || !authority.current) return { status: 'not-attempted', stop: true };
    const row = currentRows.current.find((item) => item.entry.subjectId === intent.subjectId);
    if (!row || row.unknownLabelIntent || !matchesShelfIntent(row.entry, intent)) return { status: 'not-attempted' };
    try {
      const result = await savePersonalLibraryEntry({ data: intent, headers: csrfHeaders() });
      if (!mounted.current) return { status: 'unknown', stop: true };
      if (result.ok && result.entry && result.entry.subjectId === intent.subjectId) {
        const saved = result.entry;
        patch(intent.subjectId, (current) => ({
          entry: {
            ...withoutIncarnation(current.entry),
            ...saved,
            stateLabel:
              current.entry.stateOptions?.find((option) => option.id === saved.state)?.label.text ??
              current.entry.stateLabel ??
              m.library_other(),
            revision: saved.revision,
            ...(saved.incarnationId === undefined ? {} : { incarnationId: saved.incarnationId }),
            updatedAt: saved.updatedAt,
            changeKey: crypto.randomUUID(),
          },
          conflict: false,
          failure: null,
        }));
        return { status: 'changed' };
      }
      if (!result.ok && result.reason === 'conflict') {
        patch(intent.subjectId, (current) => ({
          entry: { ...withoutIncarnation(current.entry), ...result.entry, changeKey: crypto.randomUUID() },
          conflict: true,
          failure: null,
        }));
        return { status: 'conflicted' };
      }
      if (!result.ok && result.reason === 'missing') {
        patch(intent.subjectId, () => null);
        return { status: 'failed' };
      }
      if (!result.ok && result.reason !== 'unavailable') {
        patch(intent.subjectId, (current) => ({
          entry: { ...current.entry, changeKey: crypto.randomUUID() },
          conflict: false,
          failure: failureOf(result.reason),
        }));
        return { status: 'failed', stop: ['closed', 'denied', 'signed-out'].includes(result.reason) };
      }
    } catch {
      // Transport loss says nothing about whether the native command committed.
    }
    patch(intent.subjectId, (current) => ({ ...current, failure: 'unavailable', unknownIntent: intent }));
    return { status: 'unknown' };
  };

  const eligible = rows.filter((row) => selectableEntry(row.entry));
  const selectedRows = rows.filter((row) => selected.includes(row.entry.subjectId) && selectableEntry(row.entry));
  const commonStates = commonShelfStates(selectedRows.map((row) => row.entry));
  const select = (subjectId: string, value: boolean) => {
    if (busy.current || !eligible.some((row) => row.entry.subjectId === subjectId)) return;
    setSelected((current) =>
      value
        ? current.includes(subjectId) || current.length >= shelfSelectionLimit
          ? current
          : [...current, subjectId]
        : current.filter((id) => id !== subjectId),
    );
  };
  const record = (subjectId: string, status: ShelfOutcome['status']) => {
    if (!mounted.current) return;
    setOutcomes((current) =>
      current.map((outcome) => (outcome.subjectId === subjectId ? { ...outcome, status } : outcome)),
    );
    if (status === 'changed' || status === 'unchanged')
      setSelected((current) => current.filter((id) => id !== subjectId));
  };
  const changeState = async (subjectId: string, value: string) => {
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    if (!row || row.unknownIntent || row.unknownLabelIntent || row.entry.state === value || !authority.current) return;
    const intent = shelfStateIntent(row.entry, value);
    if (!intent || !lock()) return;
    try {
      record(subjectId, (await transition(intent)).status);
    } finally {
      unlock();
    }
  };
  const retryState = async (subjectId: string) => {
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    const intent = row?.unknownIntent;
    if (!row || !intent || !matchesShelfIntent(row.entry, intent) || !authority.current || !lock()) return;
    try {
      record(subjectId, (await transition(intent)).status);
    } finally {
      unlock();
    }
  };
  const changeSelectedState = async (value: string) => {
    // Capture all targets and CAS identities before the first await, including already-current entries.
    const targets = currentRows.current.filter((row) => selected.includes(row.entry.subjectId));
    if (
      !targets.length ||
      targets.length > shelfSelectionLimit ||
      targets.some((row) => row.unknownIntent || row.unknownLabelIntent) ||
      !commonShelfStates(targets.map((row) => row.entry)).some((option) => option.id === value) ||
      !authority.current
    )
      return;
    const snapshot = targets.map((row) => ({
      intent: shelfStateIntent(row.entry, value)!,
      unchanged: row.entry.state === value,
      title: row.entry.subject
        ? displayLibraryTitle(row.entry.subject.label, locale).text
        : m.library_subject_unavailable(),
    }));
    if (!lock()) return;
    setOutcomes(snapshot.map(({ intent, title }) => ({ subjectId: intent.subjectId, title, status: 'not-attempted' })));
    try {
      for (const { intent, unchanged } of snapshot) {
        if (!mounted.current || !authority.current) break;
        if (unchanged) {
          record(intent.subjectId, 'unchanged');
          continue;
        }
        const result = await transition(intent);
        record(intent.subjectId, result.status);
        if (result.stop) break;
      }
    } finally {
      unlock();
    }
  };

  const recordLabel = (subjectId: string, result: Pick<ShelfLabelOutcome, 'status' | 'reason'>) => {
    if (!mounted.current) return;
    setLabelOutcomes((current) =>
      current.map((outcome) =>
        outcome.subjectId === subjectId ? { subjectId, title: outcome.title, ...result } : outcome,
      ),
    );
  };
  const assignLabel = async (intent: ShelfLabelIntent): Promise<Pick<ShelfLabelOutcome, 'status' | 'reason'>> => {
    const row = currentRows.current.find((item) => item.entry.subjectId === intent.input.subjectId);
    if (
      !mounted.current ||
      !labelAuthority.current ||
      !row ||
      row.unknownIntent ||
      !matchesShelfLabelIntent(row.entry, intent)
    )
      return { status: 'not-attempted' };
    try {
      const result = await mutateSubjectLabelAction({ data: intent.input, headers: csrfHeaders() });
      if (!mounted.current) return { status: 'unknown' };
      if (
        result.ok &&
        typeof result.assignment?.id === 'string' &&
        result.assignment.id.length > 0 &&
        Number.isSafeInteger(result.assignment.revision) &&
        result.assignment.revision > 0
      ) {
        patch(intent.input.subjectId, (current) => {
          const next = { ...current };
          delete next.unknownLabelIntent;
          return next;
        });
        return { status: 'assigned' };
      }
      if (
        !result.ok &&
        (result.reason === 'capacity' || result.reason === 'closed' || result.reason === 'signed-out')
      ) {
        // Refusing a recovery attempt does not prove what happened to the original command.
        return { status: row.unknownLabelIntent ? 'unknown' : 'failed', reason: result.reason };
      }
    } catch {
      // The ordinary adapter can collapse transport loss or refusal to unavailable. Keep the exact command.
    }
    patch(intent.input.subjectId, (current) => ({ ...current, unknownLabelIntent: intent }));
    return { status: 'unknown' };
  };
  const assignSelectedLabel = async (label: LibraryLabelSummary) => {
    const targets = currentRows.current.filter((row) => selected.includes(row.entry.subjectId));
    if (
      !labelAuthority.current ||
      !targets.length ||
      targets.length > shelfSelectionLimit ||
      currentRows.current.some((row) => row.unknownLabelIntent) ||
      targets.some((row) => row.unknownIntent || !selectableEntry(row.entry))
    )
      return;
    // Fixed loaded targets, row identities, supplied label name and independent command keys before any await.
    const snapshot = targets.map(({ entry }) => ({
      intent: {
        input: {
          intent: 'assign' as const,
          subjectId: entry.subjectId,
          labelId: label.id,
          idempotencyKey: crypto.randomUUID(),
        },
        labelName: label.name,
        entry: {
          subjectId: entry.subjectId,
          revision: entry.revision,
          changeKey: entry.changeKey,
          removeKey: entry.removeKey,
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
        },
      },
      title: entry.subject ? displayLibraryTitle(entry.subject.label, locale).text : m.library_subject_unavailable(),
    }));
    if (!lock()) return;
    setAssignedLabelName(label.name);
    setLabelOutcomes(
      snapshot.map(({ intent, title }) => ({ subjectId: intent.input.subjectId, title, status: 'not-attempted' })),
    );
    try {
      for (const { intent } of snapshot) {
        if (!mounted.current || !labelAuthority.current) break;
        const result = await assignLabel(intent);
        recordLabel(intent.input.subjectId, result);
        if (result.status !== 'assigned') break;
      }
    } finally {
      unlock();
    }
  };
  const retryLabel = async (subjectId: string) => {
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    const intent = row?.unknownLabelIntent;
    if (
      !row ||
      !intent ||
      row.unknownIntent ||
      !matchesShelfLabelIntent(row.entry, intent) ||
      !labelAuthority.current ||
      !lock()
    )
      return;
    try {
      recordLabel(subjectId, await assignLabel(intent));
    } finally {
      unlock();
    }
  };

  const remove = async () => {
    const subjectId = removing;
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    if (!subjectId || !row || row.unknownIntent || row.unknownLabelIntent || !lock()) return;
    try {
      const { entry } = row;
      const result = await deletePersonalLibraryEntry({
        data: {
          subjectId,
          revision: entry.revision,
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
          idempotencyKey: entry.removeKey,
        },
        headers: csrfHeaders(),
      });
      if (!mounted.current) return;
      if (result.ok || result.reason === 'missing') {
        patch(subjectId, () => null);
        if (result.ok && result.undo && restoreAdmitted) {
          const receipt = result.undo;
          undoToast(
            m.library_removed(),
            () => {
              const restore = () => {
                if (!mounted.current || !restoreAdmitted) return;
                // Undo is an explicit user command too. Keep it behind the current request lease rather than losing it.
                if (!lock()) {
                  queuedUndo.current = restore;
                  return;
                }
                void restorePersonalLibraryEntryAction({ data: { subjectId, ...receipt }, headers: csrfHeaders() })
                  .then((restored) => {
                    if (!mounted.current) return;
                    if (restored.ok) {
                      updateRows((current) => [
                        ...current.filter((row) => row.entry.subjectId !== subjectId),
                        {
                          entry: { ...restored.entry, changeKey: crypto.randomUUID(), removeKey: crypto.randomUUID() },
                          conflict: false,
                          failure: null,
                        },
                      ]);
                      setRestoreMessage(null);
                    } else if (restored.reason === 'occupied') {
                      if (restored.entry)
                        updateRows((current) => [
                          ...current.filter((row) => row.entry.subjectId !== subjectId),
                          {
                            entry: {
                              ...restored.entry!,
                              changeKey: crypto.randomUUID(),
                              removeKey: crypto.randomUUID(),
                            },
                            conflict: false,
                            failure: null,
                          },
                        ]);
                      setRestoreMessage(m.library_restore_occupied());
                    } else if (restored.reason === 'stale') setRestoreMessage(m.library_restore_stale());
                    else if (restored.reason === 'expired') setRestoreMessage(m.library_restore_expired());
                    else setRestoreMessage(m.library_subject_unavailable());
                  })
                  .catch(() => {
                    if (mounted.current) setRestoreMessage(m.library_subject_unavailable());
                  })
                  .finally(unlock);
              };
              restore();
            },
            { undo: m.editor_undo() },
          );
        }
      } else if (result.reason === 'conflict') {
        patch(subjectId, (current) => {
          return {
            entry: {
              ...withoutIncarnation(current.entry),
              ...result.entry,
              ...(result.entry.incarnationId === undefined ? {} : { incarnationId: result.entry.incarnationId }),
              removeKey: crypto.randomUUID(),
            },
            conflict: true,
            failure: null,
          };
        });
      } else {
        patch(subjectId, (current) => ({ ...current, failure: failureOf(result.reason) }));
      }
    } catch {
      patch(subjectId, (current) => ({ ...current, failure: 'unavailable' }));
    } finally {
      unlock();
      if (mounted.current) setRemoving(null);
    }
  };

  return {
    rows,
    pending,
    restoreMessage,
    removing,
    selected: selectedRows.map((row) => row.entry.subjectId),
    commonStates,
    outcomes,
    labelOutcomes,
    assignedLabelName,
    labelWriteAdmitted,
    assignSelectedLabel,
    retryLabel,
    labelSelectionBlocked:
      selectedRows.some((row) => !!row.unknownIntent) || rows.some((row) => !!row.unknownLabelIntent),
    select,
    selectPage: () => {
      if (!busy.current) setSelected(eligible.slice(0, shelfSelectionLimit).map((row) => row.entry.subjectId));
    },
    clearSelection: () => {
      if (!busy.current) setSelected([]);
    },
    changeSelectedState,
    retryState,
    writeAdmitted,
    selectionBlocked: selectedRows.some((row) => !!row.unknownIntent || !!row.unknownLabelIntent),
    askRemove: (subjectId: string) => {
      if (
        !busy.current &&
        !currentRows.current.some((row) => row.entry.subjectId === subjectId && row.unknownLabelIntent)
      )
        setRemoving(subjectId);
    },
    cancelRemove: () => setRemoving(null),
    changeState,
    remove,
  };
}
