import {
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { undoToast } from '@rezics/ui/undo-toast';
import { m } from '../paraglide/messages.js';
import { useOperation } from '../kernel/exposure';
import { csrfHeaders } from '../threads/composer';
import {
  deletePersonalLibraryEntry,
  restorePersonalLibraryEntryAction,
  savePersonalLibraryEntry,
} from './entries-actions';
import { useAuthoringDeparture } from '../threads/authoring-departure';
import type { LibraryRestoreInput, LibraryRestoreResult, PersonalLibraryEntry } from './entries-read';
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
import { useSession } from '../session/query';
import { readShelfLabelAssignment } from './labels-actions';
import { captureShelfLabelEntry, executeShelfLabelRequest, type ShelfLabelKind } from './shelf-label-request';
import { PersonalShelfOrigin } from './personal-shelf-origin';
import {
  bulkStatusReviewMatches,
  bulkStatusSelectionSignature,
  captureBulkStatusPreview,
  createBulkStatusManifest,
  bulkStatusSender,
  type BulkStatusManifest,
  type BulkStatusOperation,
  type BulkStatusSelectionItem,
  type BulkStatusTargetOutcome,
} from './bulk-status';

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

type BulkStatusReview = {
  manifest: BulkStatusManifest;
  signature: string;
  locale: string;
  state: string;
  stateLabel: string;
  targets: readonly { subjectId: string; title: string }[];
  operationId?: string;
  operation?: BulkStatusOperation;
  outcomes: readonly BulkStatusTargetOutcome[];
  phase: 'previewing' | 'preview-uncertain' | 'ready' | 'confirming' | 'uncertain' | 'recovering' | 'complete';
  readError?: boolean;
};

function bulkStatusItems(rows: readonly ShelfRow[], ids: readonly string[]): BulkStatusSelectionItem[] {
  return rows
    .filter(({ entry }) => ids.includes(entry.subjectId))
    .map(({ entry }) => ({
      subjectId: entry.subjectId,
      state: entry.state ?? '',
      revision: entry.revision,
      changeKey: entry.changeKey,
      ...(entry.incarnationId == null ? {} : { incarnationId: entry.incarnationId }),
    }));
}

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
  const session = useSession();
  const [rows, setRows] = useState<ShelfRow[]>(() =>
    initial.map((entry) => ({ entry, conflict: false, failure: null })),
  );
  const currentRows = useRef(rows);
  const mounted = useRef(true);
  const currentLocale = useRef(locale);
  currentLocale.current = locale;
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
  const [selected, setSelectedState] = useState<string[]>([]);
  const currentSelection = useRef(selected);
  const [bulkStatusReviewState, setBulkStatusReviewState] = useState<BulkStatusReview | null>(null);
  const bulkStatusReview = useRef(bulkStatusReviewState);
  const [bulkStatusReviewChanged, setBulkStatusReviewChanged] = useState(false);
  const [bulkStatusError, setBulkStatusError] = useState<'preview' | 'confirmation' | 'read' | null>(null);
  const updateBulkStatusReview = (next: BulkStatusReview | null) => {
    bulkStatusReview.current = next;
    setBulkStatusReviewState(next);
    if (next) {
      setBulkStatusReviewChanged(false);
      setBulkStatusError(null);
    }
  };
  const invalidateBulkStatusReview = useCallback((announce = true) => {
    const hadReview = bulkStatusReview.current !== null;
    bulkStatusReview.current = null;
    setBulkStatusReviewState(null);
    setBulkStatusReviewChanged(announce && hadReview);
    setBulkStatusError(null);
  }, []);
  const setSelected = useCallback(
    (change: string[] | ((value: string[]) => string[])) => {
      const next = typeof change === 'function' ? change(currentSelection.current) : change;
      if (
        next.length !== currentSelection.current.length ||
        next.some((id, index) => id !== currentSelection.current[index])
      )
        invalidateBulkStatusReview();
      currentSelection.current = next;
      setSelectedState(next);
    },
    [invalidateBulkStatusReview],
  );
  const labelOperation = useRef<{ id: string; running: boolean } | null>(null);
  const [outcomes, setOutcomes] = useState<ShelfOutcome[]>([]);
  const stateCommands = useRef(
    new WeakMap<ShelfStateIntent, { headers: Headers; send: typeof savePersonalLibraryEntry }>(),
  );
  const labelCommands = useRef(
    new WeakMap<ShelfLabelIntent, { headers: Headers; send: typeof mutateSubjectLabelAction }>(),
  );
  const [labelOutcomes, setLabelOutcomes] = useState<ShelfLabelOutcome[]>([]);
  const [assignedLabelName, setAssignedLabelName] = useState('');
  const [labelKind, setLabelKind] = useState<ShelfLabelKind>('assign');
  const [removing, setRemoving] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const restoreIntent = useRef<{
    input: LibraryRestoreInput;
    headers: Headers;
    send: typeof restorePersonalLibraryEntryAction;
    response?: LibraryRestoreResult | undefined;
    alive: () => boolean;
    running: boolean;
  } | null>(null);
  const restoreAdmitted = useOperation('library_entry.restore');
  const writeAdmitted = useOperation('library_entry.put');
  const bulkPreviewAdmitted = useOperation('library_operation.preview');
  const bulkConfirmAdmitted = useOperation('library_operation.confirm');
  const bulkReadAdmitted = useOperation('library_operation.get');
  const bulkOutcomesAdmitted = useOperation('library_operation.outcomes');
  const removeAdmitted = useOperation('library_entry.delete');
  const progress = useOperation('progress_session.list');
  const list = useOperation('library_entry.list');
  const copies = useOperation('copy.list');
  const origin = useRef(originatingCurrent);
  origin.current = originatingCurrent;
  const epoch = shelfOrigin?.epoch?.('library_entry.list', 'progress_session.list');
  const rowCurrent = useMemo(
    () => shelfOrigin?.capture('library_entry.list', 'progress_session.list'),
    [shelfOrigin, epoch],
  );
  const isCurrent = useCallback(
    () =>
      (rowCurrent?.() ?? true) && mounted.current && (origin.current?.() ?? true) && (shelfOrigin?.current() ?? true),
    [shelfOrigin, rowCurrent],
  );
  const labelWriteAdmitted = useOperation('library_label.assign');
  const labelListAdmitted = useOperation('library_label.list');
  const labelRemoveAdmitted = useOperation('library_label.unassign');
  const labelReadAdmitted = useOperation('library_label.assignment_list');
  const headers = () => shelfOrigin?.headers() ?? csrfHeaders();
  const captureMutationHeaders = () => {
    const captured = new Headers(headers());
    return captured.get('x-csrf-token')?.trim() ? captured : null;
  };
  const hasMutationCredential = () => !!new Headers(headers()).get('x-csrf-token')?.trim();
  const guard = (fallback: boolean, ...ops: Parameters<NonNullable<typeof shelfOrigin>['capture']>) => {
    const current = shelfOrigin?.capture(...ops);
    return () => isCurrent() && (current ? current() : fallback);
  };
  const stateCurrent = guard(writeAdmitted, 'library_entry.put');
  const bulkPreviewCurrent = guard(bulkPreviewAdmitted, 'library_operation.preview');
  const bulkConfirmCurrent = guard(bulkConfirmAdmitted, 'library_operation.confirm');
  const bulkReadCurrent = guard(bulkReadAdmitted, 'library_operation.get');
  const bulkOutcomesCurrent = guard(bulkOutcomesAdmitted, 'library_operation.outcomes');
  const bulkWriteCurrent = () => bulkPreviewCurrent() && bulkConfirmCurrent();
  const bulkReadResultCurrent = () => bulkReadCurrent() && bulkOutcomesCurrent();
  const labelCurrent = guard(labelWriteAdmitted && labelListAdmitted, 'library_label.assign', 'library_label.list');
  const labelRemoveCurrent = guard(
    labelRemoveAdmitted && labelListAdmitted && labelReadAdmitted,
    'library_label.unassign',
    'library_label.list',
    'library_label.assignment_list',
  );
  const labelKindCurrent = (kind: ShelfLabelKind) => (kind === 'assign' ? labelCurrent() : labelRemoveCurrent());
  const removeCurrent = guard(removeAdmitted, 'library_entry.delete');
  const restoreCurrent = guard(restoreAdmitted, 'library_entry.restore');
  const latestRestoreCurrent = useRef(restoreCurrent);
  latestRestoreCurrent.current = restoreCurrent;
  if (restoreIntent.current && !restoreIntent.current.alive()) {
    restoreIntent.current = null;
    setRestoreMessage(null);
  }
  const discardRestore = () => {
    restoreIntent.current = null;
    queuedUndo.current = null;
    setRestoreMessage(null);
  };
  useAuthoringDeparture(
    () => !!restoreIntent.current?.alive(),
    () => restoreIntent.current !== null,
    `${locale}:${restoreMessage}:${restoreIntent.current?.input.idempotencyKey}`,
    discardRestore,
    discardRestore,
  );
  const copiesCurrent = guard(copies, 'copy.list');
  const progressCurrent = guard(progress, 'progress_session.list');
  const listCurrent = guard(list, 'library_entry.list');
  const versions = [
    shelfOrigin?.version('library_entry.put'),
    shelfOrigin?.version(
      'library_label.assign',
      'library_label.list',
      'library_label.unassign',
      'library_label.assignment_list',
    ),
    shelfOrigin?.version('library_entry.delete'),
    shelfOrigin?.version(
      'library_operation.preview',
      'library_operation.confirm',
      'library_operation.get',
      'library_operation.outcomes',
    ),
  ];
  const previousVersions = useRef(versions);
  if (versions.some((version, i) => version !== previousVersions.current[i])) {
    const [state, label, remove, bulk] = versions.map((version, i) => version !== previousVersions.current[i]);
    previousVersions.current = versions;
    // Fresh commands get new keys after retirement; uncertain native commands keep their exact input.
    const next = currentRows.current.map((row) => {
      const next = { ...row, entry: { ...row.entry } };
      if (state) {
        if (!next.unknownIntent) next.entry.changeKey = crypto.randomUUID();
      }
      if (remove) {
        if (!next.unknownRemove) next.entry.removeKey = crypto.randomUUID();
      }
      return next;
    });
    currentRows.current = next;
    setRows(next);
    if (state) {
      setOutcomes([]);
    }
    if (bulk) invalidateBulkStatusReview(false);
    if (label && !currentRows.current.some((row) => row.unknownLabelIntent)) {
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
      restoreIntent.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (bulkStatusReview.current && bulkStatusReview.current.locale !== locale) invalidateBulkStatusReview(false);
  }, [locale, invalidateBulkStatusReview]);
  useEffect(() => {
    const unwatch = shelfOrigin?.watch(() => {
      if (!isCurrent()) invalidateBulkStatusReview(false);
    });
    return unwatch;
  }, [shelfOrigin, isCurrent, invalidateBulkStatusReview]);

  const previousInitial = useRef(initial);
  if (previousInitial.current !== initial) {
    previousInitial.current = initial;
    const unresolved = currentRows.current.filter(
      (row) => row.unknownIntent || row.unknownLabelIntent || row.unknownRemove || busy.current,
    );
    const next = initial.map((entry) => {
      const retained = unresolved.find((row) => row.entry.subjectId === entry.subjectId);
      if (!retained) return { entry, conflict: false, failure: null };
      return retained.unknownLabelIntent || labelOperation.current?.running ? { ...retained, entry } : retained;
    });
    for (const row of unresolved)
      if (!next.some((item) => item.entry.subjectId === row.entry.subjectId)) next.push(row);
    currentRows.current = next;
    setRows(next);
    const review = bulkStatusReview.current;
    if (
      review &&
      review.signature !== bulkStatusSelectionSignature(bulkStatusItems(next, currentSelection.current), review.state)
    )
      invalidateBulkStatusReview();
    setSelected((current) =>
      current.filter((id) => next.some((row) => row.entry.subjectId === id && row.entry.subject !== null)),
    );
  }

  // Update the imperative snapshot together with React state, so a sequence never reads a previous render's rows.
  const updateRows = useCallback(
    (change: (current: ShelfRow[]) => ShelfRow[]) => {
      if (!isCurrent()) return;
      const next = change(currentRows.current);
      currentRows.current = next;
      setRows(next);
      const review = bulkStatusReview.current;
      if (
        review &&
        review.signature !== bulkStatusSelectionSignature(bulkStatusItems(next, currentSelection.current), review.state)
      )
        invalidateBulkStatusReview();
      setSelected((current) =>
        current.filter((id) => next.some((row) => row.entry.subjectId === id && row.entry.subject !== null)),
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
    let command = stateCommands.current.get(intent);
    if (!command) {
      const requestHeaders = captureMutationHeaders();
      if (!requestHeaders) return { status: 'not-attempted', stop: true };
      command = { headers: requestHeaders, send: savePersonalLibraryEntry };
      stateCommands.current.set(intent, command);
    }
    patch(intent.subjectId, (current) => ({ ...current, unknownIntent: intent }));
    try {
      const result = await command.send({ data: intent, headers: new Headers(command.headers) });
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
        // A refused replay cannot establish whether the earlier, unanswered command committed.
        if (row.unknownIntent) {
          patch(intent.subjectId, (current) => ({ ...current, failure: failureOf(result.reason) }));
          return { status: 'unknown', stop: ['closed', 'denied', 'signed-out'].includes(result.reason) };
        }
        patch(intent.subjectId, (current) => {
          const next = { ...current };
          delete next.unknownIntent;
          return {
            ...next,
            entry: { ...current.entry, changeKey: crypto.randomUUID() },
            conflict: false,
            failure: failureOf(result.reason),
          };
        });
        return { status: 'failed', stop: ['closed', 'denied', 'signed-out'].includes(result.reason) };
      }
    } catch {
      // Transport loss says nothing about whether the native command committed.
    }
    if (!isCurrent() || !stateCurrent()) return { status: 'unknown', stop: true };
    patch(intent.subjectId, (current) => ({ ...current, failure: 'unavailable', unknownIntent: intent }));
    return { status: 'unknown' };
  };

  const selectable = (entry: PersonalLibraryEntry) =>
    selectableEntry(entry) || (entry.subject !== null && (labelCurrent() || labelRemoveCurrent()));
  const eligible = rows.filter((row) => selectable(row.entry));
  const selectedRows = rows.filter((row) => selected.includes(row.entry.subjectId) && selectable(row.entry));
  const commonStates = commonShelfStates(selectedRows.map((row) => row.entry));
  const select = (subjectId: string, value: boolean) => {
    if (
      !isCurrent() ||
      (busy.current && !labelOperation.current?.running) ||
      !eligible.some((row) => row.entry.subjectId === subjectId)
    )
      return;
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
      !stateCurrent() ||
      !hasMutationCredential()
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
  // Recovery belongs to the captured action, even when the person has selected different rows since it stopped.
  const recoverableState = (subjectId: string) => {
    if (!stateCurrent()) return undefined;
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    if (!row || row.unknownRemove || row.unknownLabelIntent) return undefined;
    const intent = row.unknownIntent;
    if (!intent || !matchesShelfIntent(row.entry, intent)) return undefined;
    if (!stateCommands.current.has(intent) && !hasMutationCredential()) return undefined;
    return { intent };
  };
  const retryState = async (subjectId: string) => {
    const target = recoverableState(subjectId);
    if (!target) return;
    const release = lock(stateCurrent);
    if (!release) return;
    try {
      record(subjectId, (await transition(target.intent)).status);
    } finally {
      release();
    }
  };
  const selectedBulkRows = () =>
    currentRows.current.filter((row) => currentSelection.current.includes(row.entry.subjectId));
  const bulkSignature = (state: string) =>
    bulkStatusSelectionSignature(bulkStatusItems(currentRows.current, currentSelection.current), state);
  const bulkReviewIsCurrent = (review: BulkStatusReview) =>
    bulkStatusReviewMatches(
      review.signature,
      bulkStatusItems(currentRows.current, currentSelection.current),
      review.state,
      review.locale,
      currentLocale.current,
      isCurrent() && bulkStatusReview.current?.manifest === review.manifest,
    );
  const previewSelectedState = async (value: string) => {
    const targets = selectedBulkRows();
    if (
      !value ||
      !targets.length ||
      targets.some((row) => row.unknownIntent || row.unknownLabelIntent || row.unknownRemove) ||
      !commonShelfStates(targets.map((row) => row.entry)).some((option) => option.id === value) ||
      !bulkWriteCurrent() ||
      !hasMutationCredential()
    )
      return;
    const captured = captureBulkStatusPreview(
      targets.map((row) => row.entry),
      value,
    );
    if (!captured.ok) {
      setBulkStatusError('preview');
      return;
    }
    const requestHeaders = captureMutationHeaders();
    if (!requestHeaders) return;
    const release = lock(bulkPreviewCurrent);
    if (!release) return;
    const manifest = createBulkStatusManifest(captured, Object.fromEntries(requestHeaders.entries()), bulkStatusSender);
    const review: BulkStatusReview = {
      manifest,
      signature: bulkSignature(value),
      locale,
      state: value,
      stateLabel: commonStates.find((choice) => choice.id === value)?.label.text ?? value,
      targets: targets.map(({ entry }) => ({
        subjectId: entry.subjectId,
        title: entry.subject ? displayLibraryTitle(entry.subject.label, locale).text : m.library_subject_unavailable(),
      })),
      outcomes: [],
      phase: 'previewing',
    };
    updateBulkStatusReview(review);
    try {
      const operation = await manifest.sender.preview(manifest.preview);
      if (!bulkReviewIsCurrent(review)) return;
      updateBulkStatusReview({
        ...review,
        operation,
        operationId: operation.id,
        phase: operation.phase === 'preview' ? 'ready' : 'complete',
      });
    } catch {
      if (bulkReviewIsCurrent(review)) {
        updateBulkStatusReview({ ...review, phase: 'preview-uncertain' });
        setBulkStatusError('preview');
      }
    } finally {
      release();
    }
  };
  const retryBulkStatusPreview = async () => {
    const review = bulkStatusReview.current;
    if (!review || review.phase !== 'preview-uncertain' || !bulkReviewIsCurrent(review) || !bulkPreviewCurrent())
      return;
    const release = lock(bulkPreviewCurrent);
    if (!release) return;
    updateBulkStatusReview({ ...review, phase: 'previewing' });
    try {
      const operation = await review.manifest.sender.preview(review.manifest.preview);
      if (!bulkReviewIsCurrent(review)) return;
      updateBulkStatusReview({
        ...review,
        operation,
        operationId: operation.id,
        phase: operation.phase === 'preview' ? 'ready' : 'complete',
      });
    } catch {
      if (bulkReviewIsCurrent(review)) {
        updateBulkStatusReview({ ...review, phase: 'preview-uncertain' });
        setBulkStatusError('preview');
      }
    } finally {
      release();
    }
  };
  const readBulkStatus = async (review: BulkStatusReview, returnPhase: BulkStatusReview['phase']) => {
    if (!review.operationId || !bulkReviewIsCurrent(review)) return;
    updateBulkStatusReview({ ...review, phase: 'recovering', readError: false });
    try {
      const result = await review.manifest.sender.read({
        operationId: review.operationId,
        headers: review.manifest.readHeaders,
      });
      if (!bulkReviewIsCurrent(review)) return;
      updateBulkStatusReview({
        ...review,
        operation: result.operation,
        outcomes: result.outcomes,
        phase: result.operation.phase === 'preview' ? 'ready' : 'complete',
        readError: false,
      });
    } catch {
      if (bulkReviewIsCurrent(review)) {
        updateBulkStatusReview({ ...review, phase: returnPhase, readError: true });
        setBulkStatusError('read');
      }
    }
  };
  const confirmSelectedState = async (value: string) => {
    const review = bulkStatusReview.current;
    if (!review || !review.operationId || !['ready', 'uncertain'].includes(review.phase)) return;
    if (review.state !== value || !bulkReviewIsCurrent(review)) {
      invalidateBulkStatusReview();
      return;
    }
    if (!bulkConfirmCurrent()) return;
    const release = lock(bulkConfirmCurrent);
    if (!release) return;
    updateBulkStatusReview({ ...review, phase: 'confirming', readError: false });
    try {
      const operation = await review.manifest.sender.confirm({
        ...review.manifest.confirm,
        operationId: review.operationId,
      });
      if (!bulkReviewIsCurrent(review)) return;
      const confirmed = { ...review, operation, phase: 'complete' as const };
      updateBulkStatusReview(confirmed);
      await readBulkStatus(confirmed, 'complete');
    } catch {
      if (bulkReviewIsCurrent(review)) {
        updateBulkStatusReview({ ...review, phase: 'uncertain' });
        setBulkStatusError('confirmation');
      }
    } finally {
      release();
    }
  };
  const recoverBulkStatus = async () => {
    const review = bulkStatusReview.current;
    if (!review?.operationId || !bulkReviewIsCurrent(review) || !bulkReadResultCurrent()) return;
    const release = lock(bulkReadResultCurrent);
    if (!release) return;
    await readBulkStatus(review, review.phase);
    release();
  };

  const renderedLabelOperation = labelOperation.current?.id;
  const recordLabel = (
    operationId: string,
    subjectId: string,
    result: Pick<ShelfLabelOutcome, 'status' | 'reason'>,
  ) => {
    if (!isCurrent() || labelOperation.current?.id !== operationId) return;
    setLabelOutcomes((current) =>
      current.map((outcome) =>
        outcome.subjectId === subjectId ? { subjectId, title: outcome.title, ...result } : outcome,
      ),
    );
  };
  const mutateLabel = async (intent: ShelfLabelIntent): Promise<Pick<ShelfLabelOutcome, 'status' | 'reason'>> => {
    const current = () =>
      isCurrent() &&
      labelKindCurrent(intent.input.intent === 'assign' ? 'assign' : 'unassign') &&
      labelOperation.current?.id === intent.operationId;
    const row = currentRows.current.find((item) => item.entry.subjectId === intent.input.subjectId);
    if (!current() || !row || row.unknownIntent || row.unknownRemove) return { status: 'not-attempted' };
    // A recovery replays the original label command, even after an entry-state refresh. It never adopts new CAS.
    if (!row.unknownLabelIntent && !matchesShelfLabelIntent(row.entry, intent)) return { status: 'conflicted' };
    if (row.unknownLabelIntent && row.unknownLabelIntent !== intent) return { status: 'not-attempted' };
    let command = labelCommands.current.get(intent);
    if (!command) {
      const requestHeaders = captureMutationHeaders();
      if (!requestHeaders) return { status: 'not-attempted' };
      command = { headers: requestHeaders, send: mutateSubjectLabelAction };
      labelCommands.current.set(intent, command);
    }
    patch(intent.input.subjectId, (value) => ({ ...value, unknownLabelIntent: intent }));
    recordLabel(intent.operationId, intent.input.subjectId, { status: 'unknown' });
    try {
      const result = await command.send({ data: intent.input, headers: new Headers(command.headers) });
      if (!current()) return { status: 'unknown' };
      if (
        result.ok &&
        result.assignment?.id &&
        Number.isSafeInteger(result.assignment.revision) &&
        result.assignment.revision > 0 &&
        (intent.input.intent === 'assign' || result.assignment.id === intent.input.assignmentId)
      ) {
        patch(intent.input.subjectId, (value) => {
          const next = { ...value };
          delete next.unknownLabelIntent;
          return next;
        });
        return { status: intent.input.intent === 'assign' ? 'assigned' : 'removed' };
      }
      if (!result.ok && ['capacity', 'closed', 'signed-out', 'conflict'].includes(result.reason)) {
        // A refusal during recovery cannot establish what happened to the original uncertain command.
        if (row.unknownLabelIntent) return { status: 'unknown' };
        patch(intent.input.subjectId, (value) => {
          const next = { ...value };
          delete next.unknownLabelIntent;
          return next;
        });
        if (result.reason === 'conflict') return { status: 'conflicted' };
        if (result.reason === 'capacity' || result.reason === 'closed' || result.reason === 'signed-out')
          return { status: 'failed', reason: result.reason };
      }
    } catch {
      // Transport loss leaves the exact input and key available for deliberate recovery.
    }
    return { status: 'unknown' };
  };
  const selectionIdentity = (entries: ShelfRow[], ids: string[]) =>
    JSON.stringify(
      entries.filter((row) => ids.includes(row.entry.subjectId)).map((row) => captureShelfLabelEntry(row.entry)),
    );
  const labelSelectionIdentity = selectionIdentity(rows, selected);
  const captureLabel = (kind: ShelfLabelKind = 'assign') => {
    const expected = labelSelectionIdentity;
    return () =>
      labelKindCurrent(kind) && expected === selectionIdentity(currentRows.current, currentSelection.current);
  };
  const assignSelectedLabel = async (label: LibraryLabelSummary, kind: ShelfLabelKind = 'assign') => {
    if (!captureLabel(kind)()) return;
    const targets = currentRows.current.filter((row) => currentSelection.current.includes(row.entry.subjectId));
    if (
      !targets.length ||
      targets.length > shelfSelectionLimit ||
      currentRows.current.some((row) => row.unknownLabelIntent) ||
      targets.some((row) => row.unknownIntent || row.unknownRemove || row.entry.subject === null)
    )
      return;
    const release = lock(() => labelKindCurrent(kind));
    if (!release) return;
    const operation = { id: crypto.randomUUID(), running: true };
    labelOperation.current = operation;
    const request = {
      id: operation.id,
      kind,
      label: { id: label.id, name: label.name },
      targets: targets.map(({ entry }) => ({
        entry: captureShelfLabelEntry(entry),
        title: entry.subject ? displayLibraryTitle(entry.subject.label, locale).text : m.library_subject_unavailable(),
      })),
    };
    const current = () => labelOperation.current === operation && isCurrent() && labelKindCurrent(kind);
    setAssignedLabelName(request.label.name);
    setLabelKind(kind);
    setLabelOutcomes(
      request.targets.map(({ entry, title }) => ({ subjectId: entry.subjectId, title, status: 'not-attempted' })),
    );
    try {
      await executeShelfLabelRequest(request, {
        isCurrent: current,
        entry: (id) => currentRows.current.find((row) => row.entry.subjectId === id)?.entry,
        readAssignment: async (subjectId, labelId) => {
          try {
            const read = await readShelfLabelAssignment({ data: { subjectId, labelId } });
            const viewer = shelfOrigin ? shelfOrigin.viewer() : session.subject;
            if (read.state === 'signed-out') return { ok: false, reason: 'signed-out' };
            if (
              !current() ||
              read.state !== 'loaded' ||
              read.provenance.viewer !== viewer ||
              read.provenance.subjectId !== subjectId ||
              read.provenance.labelId !== labelId ||
              (read.assignment !== null &&
                (!read.assignment.id ||
                  !Number.isSafeInteger(read.assignment.revision) ||
                  read.assignment.revision < 1))
            )
              return { ok: false, reason: 'unavailable' };
            return { ok: true, assignment: read.assignment };
          } catch {
            return { ok: false, reason: 'unavailable' };
          }
        },
        mutate: mutateLabel,
        record: (id, result) => recordLabel(request.id, id, result),
      });
    } finally {
      operation.running = false;
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
      renderedLabelOperation !== intent.operationId ||
      labelOperation.current?.id !== intent.operationId
    )
      return;
    const kind = intent.input.intent === 'assign' ? 'assign' : 'unassign';
    const release = lock(() => labelKindCurrent(kind));
    if (!release) return;
    const operation = labelOperation.current;
    operation.running = true;
    try {
      recordLabel(intent.operationId, subjectId, await mutateLabel(intent));
    } finally {
      operation.running = false;
      release();
    }
  };

  async function retryRestore() {
    const operation = restoreIntent.current;
    if (!operation || !operation.alive() || !latestRestoreCurrent.current() || operation.running) return;
    const release = lock(latestRestoreCurrent.current);
    if (!release) {
      queuedUndo.current = () => void retryRestore();
      return;
    }
    operation.running = true;
    try {
      const restored =
        operation.response ??
        (await operation.send({ data: { ...operation.input }, headers: new Headers(operation.headers) }));
      if (restored.ok || ['occupied', 'stale', 'expired'].includes(restored.reason)) operation.response = restored;
      if (!isCurrent() || restoreIntent.current !== operation || !operation.alive() || !latestRestoreCurrent.current())
        return;
      if (restored.ok || restored.reason === 'occupied') {
        if (restored.entry)
          updateRows((current) => [
            ...current.filter((row) => row.entry.subjectId !== operation.input.subjectId),
            {
              entry: { ...restored.entry!, changeKey: crypto.randomUUID(), removeKey: crypto.randomUUID() },
              conflict: false,
              failure: null,
            },
          ]);
        restoreIntent.current = null;
        setRestoreMessage(restored.ok ? null : m.library_restore_occupied());
      } else if (restored.reason === 'stale' || restored.reason === 'expired') {
        restoreIntent.current = null;
        setRestoreMessage(restored.reason === 'stale' ? m.library_restore_stale() : m.library_restore_expired());
      } else setRestoreMessage(m.library_subject_unavailable());
    } catch {
      if (restoreIntent.current === operation && operation.alive()) setRestoreMessage(m.library_subject_unavailable());
    } finally {
      operation.running = false;
      release();
    }
  }

  const remove = async () => {
    const subjectId = removing;
    const row = currentRows.current.find((item) => item.entry.subjectId === subjectId);
    if (!isCurrent() || !removeCurrent() || !subjectId || !row || row.unknownIntent || row.unknownLabelIntent) return;
    const requestHeaders = captureMutationHeaders();
    if (!requestHeaders) return;
    const release = lock(removeCurrent);
    if (!release) return;
    try {
      const { entry } = row;
      patch(subjectId, (current) => ({ ...current, unknownRemove: true }));
      const result = await deletePersonalLibraryEntry({
        data: {
          subjectId,
          revision: entry.revision,
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
          idempotencyKey: entry.removeKey,
        },
        headers: new Headers(requestHeaders),
      });
      if (!isCurrent() || !removeCurrent()) return;
      if (result.ok || result.reason === 'missing') {
        patch(subjectId, () => null);
        if (result.ok && result.undo && restoreCurrent()) {
          const input: LibraryRestoreInput = {
            subjectId,
            ...result.undo,
            idempotencyKey: result.undo.idempotencyKey ?? crypto.randomUUID(),
          };
          // Viewer/locale and exposure retirement are monotonic, independent of healthy read recovery.
          const origin = shelfOrigin;
          const viewer = origin?.viewer();
          const alive = () => mounted.current && (!origin || origin.viewer() === viewer);
          undoToast(
            m.library_removed(),
            () => {
              if (!alive() || !latestRestoreCurrent.current()) return;
              if (restoreIntent.current && restoreIntent.current.input.idempotencyKey !== input.idempotencyKey) return;
              const captured = captureMutationHeaders();
              if (!captured) return;
              restoreIntent.current ??= {
                input,
                headers: captured,
                send: restorePersonalLibraryEntryAction,
                alive,
                running: false,
              };
              void retryRestore();
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
    retryRestore,
    canRetryRestore: !!restoreIntent.current?.alive() && restoreCurrent() && !restoreIntent.current.running,
    removing,
    selectedEntries: selectedRows.map((row) => row.entry),
    selected: selectedRows.map((row) => row.entry.subjectId),
    commonStates,
    outcomes,
    bulkStatusReview: bulkStatusReviewState?.locale === locale && isCurrent() ? bulkStatusReviewState : null,
    bulkStatusReviewChanged,
    bulkStatusError,
    bulkStatusWriteAdmitted: bulkWriteCurrent() && hasMutationCredential(),
    bulkStatusReadAdmitted: bulkReadResultCurrent(),
    invalidateBulkStatusReview,
    previewSelectedState,
    retryBulkStatusPreview,
    confirmSelectedState,
    recoverBulkStatus,
    labelOutcomes,
    assignedLabelName,
    labelKind,
    labelSelectionIdentity,
    selectionPending: pending && !labelOperation.current?.running,
    labelRemoveAdmitted: labelRemoveCurrent(),
    labelWriteAdmitted: labelCurrent(),
    captureLabel,
    labelVersion: shelfOrigin?.version(
      'library_label.assign',
      'library_label.list',
      'library_label.unassign',
      'library_label.assignment_list',
    ),
    labelEpoch: shelfOrigin?.epoch?.(
      'library_entry.list',
      'progress_session.list',
      'library_label.assign',
      'library_label.list',
      'library_label.unassign',
      'library_label.assignment_list',
    ),
    assignSelectedLabel,
    retryLabel,
    canRetryLabel: (subjectId: string) => {
      const row = rows.find((item) => item.entry.subjectId === subjectId);
      return !!row?.unknownLabelIntent && row.unknownLabelIntent.operationId === renderedLabelOperation;
    },
    labelSelectionBlocked:
      selectedRows.some((row) => !!row.unknownIntent || !!row.unknownRemove) ||
      rows.some((row) => !!row.unknownLabelIntent),
    select,
    selectable,
    selectPage: () => {
      if (isCurrent() && (!busy.current || labelOperation.current?.running))
        setSelected(eligible.slice(0, shelfSelectionLimit).map((row) => row.entry.subjectId));
    },
    clearSelection: () => {
      if (isCurrent() && (!busy.current || labelOperation.current?.running)) setSelected([]);
    },
    retryState,
    canRetryState: (subjectId: string) => !!recoverableState(subjectId),
    writeAdmitted: stateCurrent() && hasMutationCredential(),
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
