import { useContext, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { PersonalShelfOrigin } from './personal-shelf-origin';

/** A synchronous lease releases only its own command, including after an originating authority retires. */
export type ShelfMutationLease = { current: boolean; owner?: symbol; listeners: Set<() => void> };
export const shelfMutationLease = (): ShelfMutationLease => ({ current: false, listeners: new Set() });

export type ShelfFailure = 'closed' | 'denied' | 'unavailable' | 'signed-out' | 'unsupported_library_profile';
/** One entry as the shelf holds it: what the kernel last said, and what happened to the last write. */
export type ShelfRow = {
  entry: PersonalLibraryEntry;
  conflict: boolean;
  failure: ShelfFailure | null;
  unknownIntent?: ShelfStateIntent;
  unknownRemove?: boolean;
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
export function useShelfRows(
  initial: PersonalLibraryEntry[],
  locale: string,
  busy: ShelfMutationLease,
  originatingCurrent?: () => boolean,
) {
  const shelfOrigin = useContext(PersonalShelfOrigin);
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
  const removeAdmitted = useOperation('library_entry.delete');
  const progress = useOperation('progress_session.list');
  const list = useOperation('library_entry.list');
  const copies = useOperation('copy.list');
  const origin = useRef(originatingCurrent);
  origin.current = originatingCurrent;
  const [rowCurrent] = useState(() => shelfOrigin?.capture('library_entry.list', 'progress_session.list'));
  const isCurrent = useCallback(
    () =>
      (rowCurrent?.() ?? true) && mounted.current && (origin.current?.() ?? true) && (shelfOrigin?.current() ?? true),
    [shelfOrigin, rowCurrent],
  );
  const labelWriteAdmitted = useOperation('library_label.assign');
  const labelListAdmitted = useOperation('library_label.list');
  const guard = (fallback: boolean, ...ops: Parameters<NonNullable<typeof shelfOrigin>['capture']>) => {
    const current = shelfOrigin?.capture(...ops);
    return () => isCurrent() && (current ? current() : fallback);
  };
  const stateCurrent = guard(writeAdmitted, 'library_entry.put');
  const labelCurrent = guard(labelWriteAdmitted && labelListAdmitted, 'library_label.assign', 'library_label.list');
  const removeCurrent = guard(removeAdmitted, 'library_entry.delete');
  const restoreCurrent = guard(restoreAdmitted, 'library_entry.restore');
  const copiesCurrent = guard(copies, 'copy.list');
  const progressCurrent = guard(progress, 'progress_session.list');
  const listCurrent = guard(list, 'library_entry.list');
  const headers = () => shelfOrigin?.headers() ?? csrfHeaders();
  const versions = [
    shelfOrigin?.version('library_entry.put'),
    shelfOrigin?.version('library_label.assign', 'library_label.list'),
    shelfOrigin?.version('library_entry.delete'),
  ];
  const previousVersions = useRef(versions);
  if (versions.some((version, i) => version !== previousVersions.current[i])) {
    const [state, label, remove] = versions.map((version, i) => version !== previousVersions.current[i]);
    previousVersions.current = versions;
    // A retired command/key cannot be revived by an admission ABA. Independently readable rows stay visible.
    const next = currentRows.current.map((row) => {
      const next = { ...row, entry: { ...row.entry } };
      if (state) {
        delete next.unknownIntent;
        next.entry.changeKey = crypto.randomUUID();
      }
      if (label) delete next.unknownLabelIntent;
      if (remove) {
        delete next.unknownRemove;
        next.entry.removeKey = crypto.randomUUID();
      }
      return next;
    });
    currentRows.current = next;
    setRows(next);
    if (state) setOutcomes([]);
    if (label) {
      setLabelOutcomes([]);
      setAssignedLabelName('');
    }
    if (remove) setRemoving(null);
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queuedUndo.current = null;
    };
  }, []);

  const previousInitial = useRef(initial);
  if (previousInitial.current !== initial) {
    previousInitial.current = initial;
    const unresolved = currentRows.current.filter(
      (row) => row.unknownIntent || row.unknownLabelIntent || row.unknownRemove || busy.current,
    );
    const next = initial.map(
      (entry) =>
        unresolved.find((row) => row.entry.subjectId === entry.subjectId) ?? { entry, conflict: false, failure: null },
    );
    for (const row of unresolved)
      if (!next.some((item) => item.entry.subjectId === row.entry.subjectId)) next.push(row);
    currentRows.current = next;
    setRows(next);
    setSelected((current) =>
      current.filter((id) => next.some((row) => row.entry.subjectId === id && selectableEntry(row.entry))),
    );
  }

  // Update the imperative snapshot together with React state, so a sequence never reads a previous render's rows.
  const updateRows = useCallback(
    (change: (current: ShelfRow[]) => ShelfRow[]) => {
      if (!isCurrent()) return;
      const next = change(currentRows.current);
      currentRows.current = next;
      setRows(next);
      setSelected((current) =>
        current.filter((id) => next.some((row) => row.entry.subjectId === id && selectableEntry(row.entry))),
      );
    },
    [isCurrent],
  );
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
  const lock = (current: () => boolean) => {
    if (!current() || busy.current) return undefined;
    const owner = Symbol();
    busy.owner = owner;
    busy.current = true;
    busy.listeners.forEach((listener) => listener());
    let unwatch: (() => void) | undefined;
    const release = () => {
      unwatch?.();
      if (busy.owner !== owner) return;
      delete busy.owner;
      busy.current = false;
      busy.listeners.forEach((listener) => listener());
      const undo = queuedUndo.current;
      queuedUndo.current = null;
      if (isCurrent()) undo?.();
    };
    unwatch = shelfOrigin?.watch(() => {
      if (!current()) release();
    });
    return release;
  };

  /** Shared by single-row changes, selected-page commands and deliberate same-key recovery. */
  const transition = async (intent: ShelfStateIntent): Promise<{ status: ShelfOutcome['status']; stop?: boolean }> => {
    if (!isCurrent() || !stateCurrent()) return { status: 'not-attempted', stop: true };
    const row = currentRows.current.find((item) => item.entry.subjectId === intent.subjectId);
    if (!row || row.unknownRemove || row.unknownLabelIntent || !matchesShelfIntent(row.entry, intent))
      return { status: 'not-attempted' };
    try {
      const result = await savePersonalLibraryEntry({ data: intent, headers: headers() });
      if (!isCurrent() || !stateCurrent()) return { status: 'unknown', stop: true };
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
    if (!isCurrent() || !stateCurrent()) return { status: 'unknown', stop: true };
    patch(intent.subjectId, (current) => ({ ...current, failure: 'unavailable', unknownIntent: intent }));
    return { status: 'unknown' };
  };

  const eligible = rows.filter((row) => selectableEntry(row.entry));
  const selectedRows = rows.filter((row) => selected.includes(row.entry.subjectId) && selectableEntry(row.entry));
  const commonStates = commonShelfStates(selectedRows.map((row) => row.entry));
  const select = (subjectId: string, value: boolean) => {
    if (!isCurrent() || busy.current || !eligible.some((row) => row.entry.subjectId === subjectId)) return;
    setSelected((current) =>
      value
        ? current.includes(subjectId) || current.length >= shelfSelectionLimit
          ? current
          : [...current, subjectId]
        : current.filter((id) => id !== subjectId),
    );
  };
  const record = (subjectId: string, status: ShelfOutcome['status']) => {
    if (!isCurrent() || !stateCurrent()) return;
    setOutcomes((current) =>
      current.map((outcome) => (outcome.subjectId === subjectId ? { ...outcome, status } : outcome)),
    );
    if (status === 'changed' || status === 'unchanged')
      setSelected((current) => current.filter((id) => id !== subjectId));
  };
  const changeState = async (subjectId: string, value: string) => {
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    if (
      !row ||
      row.unknownIntent ||
      row.unknownRemove ||
      row.unknownLabelIntent ||
      row.entry.state === value ||
      !stateCurrent()
    )
      return;
    const intent = shelfStateIntent(row.entry, value);
    if (!intent) return;
    const release = lock(stateCurrent);
    if (!release) return;
    try {
      record(subjectId, (await transition(intent)).status);
    } finally {
      release();
    }
  };
  const retryState = async (subjectId: string) => {
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    const intent = row?.unknownIntent;
    if (!row || !intent || !matchesShelfIntent(row.entry, intent) || !stateCurrent()) return;
    const release = lock(stateCurrent);
    if (!release) return;
    try {
      record(subjectId, (await transition(intent)).status);
    } finally {
      release();
    }
  };
  const changeSelectedState = async (value: string) => {
    // Capture all targets and CAS identities before the first await, including already-current entries.
    const targets = currentRows.current.filter((row) => selected.includes(row.entry.subjectId));
    if (
      !targets.length ||
      targets.length > shelfSelectionLimit ||
      targets.some((row) => row.unknownIntent || row.unknownLabelIntent || row.unknownRemove) ||
      !commonShelfStates(targets.map((row) => row.entry)).some((option) => option.id === value) ||
      !stateCurrent()
    )
      return;
    const snapshot = targets.map((row) => ({
      intent: shelfStateIntent(row.entry, value)!,
      unchanged: row.entry.state === value,
      title: row.entry.subject
        ? displayLibraryTitle(row.entry.subject.label, locale).text
        : m.library_subject_unavailable(),
    }));
    const release = lock(stateCurrent);
    if (!release) return;
    setOutcomes(snapshot.map(({ intent, title }) => ({ subjectId: intent.subjectId, title, status: 'not-attempted' })));
    try {
      for (const { intent, unchanged } of snapshot) {
        if (!isCurrent() || !stateCurrent()) break;
        if (unchanged) {
          record(intent.subjectId, 'unchanged');
          continue;
        }
        const result = await transition(intent);
        record(intent.subjectId, result.status);
        if (result.stop) break;
      }
    } finally {
      release();
    }
  };

  const recordLabel = (subjectId: string, result: Pick<ShelfLabelOutcome, 'status' | 'reason'>) => {
    if (!isCurrent() || !labelCurrent()) return;
    setLabelOutcomes((current) =>
      current.map((outcome) =>
        outcome.subjectId === subjectId ? { subjectId, title: outcome.title, ...result } : outcome,
      ),
    );
  };
  const assignLabel = async (intent: ShelfLabelIntent): Promise<Pick<ShelfLabelOutcome, 'status' | 'reason'>> => {
    const row = currentRows.current.find((item) => item.entry.subjectId === intent.input.subjectId);
    if (
      !isCurrent() ||
      !labelCurrent() ||
      !row ||
      row.unknownIntent ||
      row.unknownRemove ||
      !matchesShelfLabelIntent(row.entry, intent)
    )
      return { status: 'not-attempted' };
    try {
      const result = await mutateSubjectLabelAction({ data: intent.input, headers: headers() });
      if (!isCurrent() || !labelCurrent()) return { status: 'unknown' };
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
    if (!isCurrent() || !labelCurrent()) return { status: 'unknown' };
    patch(intent.input.subjectId, (current) => ({ ...current, unknownLabelIntent: intent }));
    return { status: 'unknown' };
  };
  const assignSelectedLabel = async (label: LibraryLabelSummary) => {
    const targets = currentRows.current.filter((row) => selected.includes(row.entry.subjectId));
    if (
      !labelCurrent() ||
      !targets.length ||
      targets.length > shelfSelectionLimit ||
      currentRows.current.some((row) => row.unknownLabelIntent) ||
      targets.some((row) => row.unknownIntent || row.unknownRemove || !selectableEntry(row.entry))
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
    const release = lock(labelCurrent);
    if (!release) return;
    setAssignedLabelName(label.name);
    setLabelOutcomes(
      snapshot.map(({ intent, title }) => ({ subjectId: intent.input.subjectId, title, status: 'not-attempted' })),
    );
    try {
      for (const { intent } of snapshot) {
        if (!isCurrent() || !labelCurrent()) break;
        const result = await assignLabel(intent);
        recordLabel(intent.input.subjectId, result);
        if (result.status !== 'assigned') break;
      }
    } finally {
      release();
    }
  };
  const retryLabel = async (subjectId: string) => {
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    const intent = row?.unknownLabelIntent;
    if (
      !row ||
      !intent ||
      row.unknownIntent ||
      row.unknownRemove ||
      !matchesShelfLabelIntent(row.entry, intent) ||
      !labelCurrent()
    )
      return;
    const release = lock(labelCurrent);
    if (!release) return;
    try {
      recordLabel(subjectId, await assignLabel(intent));
    } finally {
      release();
    }
  };

  const remove = async () => {
    const subjectId = removing;
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    if (!isCurrent() || !removeCurrent() || !subjectId || !row || row.unknownIntent || row.unknownLabelIntent) return;
    const release = lock(removeCurrent);
    if (!release) return;
    try {
      const { entry } = row;
      const result = await deletePersonalLibraryEntry({
        data: {
          subjectId,
          revision: entry.revision,
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
          idempotencyKey: entry.removeKey,
        },
        headers: headers(),
      });
      if (!isCurrent() || !removeCurrent()) return;
      if (result.ok || result.reason === 'missing') {
        patch(subjectId, () => null);
        if (result.ok && result.undo && restoreCurrent()) {
          const receipt = result.undo;
          const undoCurrent = guard(restoreAdmitted, 'library_entry.restore');
          undoToast(
            m.library_removed(),
            () => {
              const restore = () => {
                if (!undoCurrent()) return;
                // Undo is an explicit user command too. Keep it behind the current request lease rather than losing it.
                const release = lock(undoCurrent);
                if (!release) {
                  queuedUndo.current = restore;
                  return;
                }
                void restorePersonalLibraryEntryAction({ data: { subjectId, ...receipt }, headers: headers() })
                  .then((restored) => {
                    if (!undoCurrent()) return;
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
                    if (undoCurrent()) setRestoreMessage(m.library_subject_unavailable());
                  })
                  .finally(release);
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
        patch(subjectId, (current) => ({
          ...current,
          failure: failureOf(result.reason),
          unknownRemove: result.reason === 'unavailable',
        }));
      }
    } catch {
      if (isCurrent() && removeCurrent())
        patch(subjectId, (current) => ({ ...current, failure: 'unavailable', unknownRemove: true }));
    } finally {
      release();
      if (removeCurrent()) setRemoving(null);
    }
  };

  return {
    rows,
    isCurrent,
    copiesAdmitted: copiesCurrent,
    progressAdmitted: progressCurrent,
    sortAdmitted: () => progressCurrent() && listCurrent(),
    pending,
    restoreMessage,
    removing,
    selected: selectedRows.map((row) => row.entry.subjectId),
    commonStates,
    outcomes,
    labelOutcomes,
    assignedLabelName,
    labelWriteAdmitted: labelCurrent(),
    captureLabel: () => guard(labelWriteAdmitted && labelListAdmitted, 'library_label.assign', 'library_label.list'),
    labelVersion: shelfOrigin?.version('library_label.assign', 'library_label.list'),
    assignSelectedLabel,
    retryLabel,
    labelSelectionBlocked:
      selectedRows.some((row) => !!row.unknownIntent || !!row.unknownRemove) ||
      rows.some((row) => !!row.unknownLabelIntent),
    select,
    selectPage: () => {
      if (isCurrent() && !busy.current)
        setSelected(eligible.slice(0, shelfSelectionLimit).map((row) => row.entry.subjectId));
    },
    clearSelection: () => {
      if (isCurrent() && !busy.current) setSelected([]);
    },
    changeSelectedState,
    retryState,
    writeAdmitted: stateCurrent(),
    selectionBlocked: selectedRows.some(
      (row) => !!row.unknownIntent || !!row.unknownLabelIntent || !!row.unknownRemove,
    ),
    askRemove: (subjectId: string) => {
      if (
        isCurrent() &&
        removeCurrent() &&
        !busy.current &&
        !currentRows.current.some((row) => row.entry.subjectId === subjectId && row.unknownLabelIntent)
      )
        setRemoving(subjectId);
    },
    cancelRemove: () => {
      if (removeCurrent()) setRemoving(null);
    },
    changeState,
    remove,
  };
}
